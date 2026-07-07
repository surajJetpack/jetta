/**
 * One-time migration into the unified KB store (lib/kb-store.ts, jetta:kb2:*).
 *
 *   1. Seeds the in-code GetSign corpus (GETSIGN_KB) as published articles,
 *      re-using the EXACT ids scripts/kb-ingest.ts derives (slug(url)-index),
 *      so the existing vector index needs no re-embedding and doesn't churn.
 *   2. Copies old managed articles (jetta:kb:managed:*) with the same ids.
 *   3. Copies live pending drafts (jetta:kbdraft:*) as draft-state articles.
 *   4. Registers the category registry (URL-path derived for GetSign docs).
 *
 * Idempotent: existing kb2 articles are never overwritten (human edits win on
 * re-runs). Old keys are NOT deleted — cleanup happens after a soak period.
 *
 *   KV_REST_API_URL=... KV_REST_API_TOKEN=... npx tsx scripts/kb-migrate.ts [--dry-run]
 */
import { GETSIGN_KB } from "../lib/knowledge/getsign-kb";
import { listManagedArticles, listDrafts } from "../lib/kv";
import {
  getArticle,
  createArticle,
  upsertCategory,
  countByState,
  type NewArticle,
} from "../lib/kb-store";

const DRY = process.argv.includes("--dry-run");

const slug = (s: string) =>
  s.toLowerCase().replace(/https?:\/\//, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 120);

const CATEGORIES = [
  { slug: "getsign-features", name: "GetSign — Features" },
  { slug: "getsign-getting-started", name: "GetSign — Getting Started" },
  { slug: "getsign-capabilities", name: "GetSign — Capabilities" },
  { slug: "getsign-how-tos", name: "GetSign — How-tos" },
  { slug: "getsign-workflows", name: "GetSign — Workflows" },
  { slug: "getsign-general", name: "GetSign — General" },
  { slug: "support-learned", name: "Learned from Support" },
];

function categoryForUrl(url: string): string {
  if (url.includes("/feature/")) return "getsign-features";
  if (url.includes("/getting-started/")) return "getsign-getting-started";
  if (url.includes("/capabilities/")) return "getsign-capabilities";
  if (url.includes("/how-tos/")) return "getsign-how-tos";
  if (url.includes("/workflow/")) return "getsign-workflows";
  return "getsign-general";
}

async function createIfAbsent(input: NewArticle): Promise<"created" | "skipped"> {
  const existing = await getArticle(input.id!);
  if (existing) return "skipped";
  if (!DRY) {
    // No vector sync (ids already embedded) and no dup check (bulk seed).
    await createArticle(input, { syncVector: false, checkDuplicates: false });
  }
  return "created";
}

async function main() {
  console.log(`KB migration ${DRY ? "(DRY RUN — nothing written)" : ""}\n`);
  const t = Math.floor(Date.now() / 1000);
  const counts = { seeded: 0, managed: 0, drafts: 0, skipped: 0 };

  if (!DRY) for (const c of CATEGORIES) await upsertCategory(c);

  // 1. In-code GetSign corpus — ids MUST match kb-ingest.ts derivation.
  for (let i = 0; i < GETSIGN_KB.length; i++) {
    const a = GETSIGN_KB[i];
    const id = a.url ? slug(a.url) + "-" + i : `kb-${i}`;
    const res = await createIfAbsent({
      id,
      title: a.title,
      url: a.url,
      body: a.body,
      keywords: a.keywords ?? [],
      category: categoryForUrl(a.url),
      state: "published",
      origin: "seed-getsign",
      source: a.source,
      createdBy: "kb-migrate",
      reviewBy: t + 180 * 86400, // sourced 2026-06-20; due for a look in ~6 months
    });
    if (res === "created") counts.seeded++;
    else counts.skipped++;
  }
  console.log(`GetSign corpus: ${counts.seeded} seeded (of ${GETSIGN_KB.length})`);

  // 2. Old managed articles (manual + approved knowledge-loop).
  const managed = await listManagedArticles();
  for (const a of managed) {
    const res = await createIfAbsent({
      id: a.id,
      title: a.title,
      url: a.url,
      body: a.body,
      keywords: a.keywords ?? [],
      category: "support-learned",
      state: "published",
      origin: a.origin,
      source: "managed",
      createdBy: a.createdBy,
    });
    if (res === "created") counts.managed++;
    else counts.skipped++;
  }
  console.log(`Managed articles: ${counts.managed} migrated (of ${managed.length})`);

  // 3. Live pending drafts → draft-state articles (id stays = old draft id,
  //    which for Slack drafts is the thread ts `publish kb` looks up).
  const drafts = await listDrafts();
  for (const d of drafts) {
    const res = await createIfAbsent({
      id: d.id,
      title: d.title,
      url: "",
      body: d.body,
      keywords: d.keywords ?? [],
      category: "support-learned",
      state: "draft",
      origin: "knowledge-loop",
      createdBy: d.createdBy,
      meta: { channel: d.channel, threadTs: d.threadTs },
    });
    if (res === "created") counts.drafts++;
    else counts.skipped++;
  }
  console.log(`Pending drafts: ${counts.drafts} migrated (of ${drafts.length})`);

  if (!DRY) {
    const byState = await countByState();
    console.log(`\nStore now: ${JSON.stringify(byState)}`);
  }
  if (counts.skipped) console.log(`Skipped (already migrated): ${counts.skipped}`);
  console.log(
    DRY
      ? "\nDry run complete. Re-run without --dry-run to write."
      : "\nDone. Old jetta:kb:managed:* / jetta:kbdraft:* keys were left intact (cleanup after soak).",
  );
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
