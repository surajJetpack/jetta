/**
 * Ingest the curated KB + approved Knowledge-Loop articles into Upstash Vector.
 * Re-runnable (upserts by stable id). Skips the 1,216 raw workflow pages —
 * those are represented by the single consolidated "Supported Workflows" entry.
 *
 *   UPSTASH_VECTOR_REST_URL=... UPSTASH_VECTOR_REST_TOKEN=... \
 *   GOOGLE_GENERATIVE_AI_API_KEY=... LLM_PROVIDER=google npx tsx scripts/kb-ingest.ts
 */
import { GETSIGN_KB } from "../lib/knowledge/getsign-kb";
import { listApprovedArticles } from "../lib/kv";
import { listAllSolutionArticles } from "../lib/tools/freshdesk";
import { upsertDocs, vectorEnabled, type VectorDoc } from "../lib/vector";

const slug = (s: string) =>
  s.toLowerCase().replace(/https?:\/\//, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 120);

async function main() {
  if (!vectorEnabled()) {
    console.error("Vector store not configured (UPSTASH_VECTOR_REST_URL/TOKEN). Aborting.");
    process.exit(1);
  }

  const docs: VectorDoc[] = GETSIGN_KB.map((a, i) => ({
    id: a.url ? slug(a.url) + "-" + i : `kb-${i}`,
    title: a.title,
    url: a.url,
    body: a.body,
    source: a.source,
  }));

  // Full Freshdesk Solutions KB (all products: General, GetSign, Vlookup, …).
  const fd = await listAllSolutionArticles().catch((e) => {
    console.warn("Freshdesk article fetch failed:", e instanceof Error ? e.message : e);
    return [];
  });
  for (const a of fd) {
    docs.push({ id: `fd-${a.id}`, title: a.title, url: a.url, body: a.body, source: `freshdesk:${a.category}` });
  }

  const approved = await listApprovedArticles();
  for (const a of approved) {
    docs.push({ id: `loop-${a.at}`, title: a.title, url: a.url, body: a.body, source: "knowledge-loop" });
  }

  console.log(`Ingesting ${docs.length} docs (${GETSIGN_KB.length} static + ${fd.length} freshdesk + ${approved.length} approved)…`);
  // Embed/upsert in batches to stay within request limits.
  const BATCH = 25;
  let done = 0;
  for (let i = 0; i < docs.length; i += BATCH) {
    done += await upsertDocs(docs.slice(i, i + BATCH));
    console.log(`  upserted ${done}/${docs.length}`);
  }
  console.log("Done.");
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
