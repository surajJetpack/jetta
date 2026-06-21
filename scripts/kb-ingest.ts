/**
 * Rebuild the vector index from the two trusted sources: the curated GetSign KB
 * (git) + managed articles (Redis, incl. Knowledge-Loop approved). Freshdesk is
 * intentionally NOT ingested. Resets the index first so removed/Freshdesk docs
 * don't linger.
 *
 *   UPSTASH_VECTOR_REST_URL=... UPSTASH_VECTOR_REST_TOKEN=... \
 *   GOOGLE_GENERATIVE_AI_API_KEY=... LLM_PROVIDER=google npx tsx scripts/kb-ingest.ts
 */
import { GETSIGN_KB } from "../lib/knowledge/getsign-kb";
import { listManagedArticles } from "../lib/kv";
import { upsertDocs, resetIndex, vectorEnabled, type VectorDoc } from "../lib/vector";

const slug = (s: string) =>
  s.toLowerCase().replace(/https?:\/\//, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 120);

async function main() {
  if (!vectorEnabled()) {
    console.error("Vector store not configured (UPSTASH_VECTOR_REST_URL/TOKEN). Aborting.");
    process.exit(1);
  }

  console.log("Resetting index…");
  await resetIndex();

  const docs: VectorDoc[] = GETSIGN_KB.map((a, i) => ({
    id: a.url ? slug(a.url) + "-" + i : `kb-${i}`,
    title: a.title,
    url: a.url,
    body: a.body,
    source: a.source,
  }));

  const managed = await listManagedArticles();
  for (const a of managed) {
    docs.push({ id: a.id, title: a.title, url: a.url, body: a.body, source: "managed" });
  }

  console.log(`Ingesting ${docs.length} docs (${GETSIGN_KB.length} curated + ${managed.length} managed)…`);
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
