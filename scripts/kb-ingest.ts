/**
 * Rebuild the vector index from the unified KB store: PUBLISHED articles only
 * (seeded GetSign corpus + manual + approved Knowledge-Loop). Freshdesk is
 * intentionally NOT ingested. Resets the index first so removed/unpublished
 * docs don't linger.
 *
 * Run scripts/kb-migrate.ts first if the store is empty (fresh environment).
 *
 *   UPSTASH_VECTOR_REST_URL=... UPSTASH_VECTOR_REST_TOKEN=... \
 *   KV_REST_API_URL=... KV_REST_API_TOKEN=... \
 *   GOOGLE_GENERATIVE_AI_API_KEY=... npx tsx scripts/kb-ingest.ts
 */
import { listArticles } from "../lib/kb-store";
import { upsertDocs, resetIndex, vectorEnabled, type VectorDoc } from "../lib/vector";

async function main() {
  if (!vectorEnabled()) {
    console.error("Vector store not configured (UPSTASH_VECTOR_REST_URL/TOKEN). Aborting.");
    process.exit(1);
  }

  const published = await listArticles({ state: "published", limit: 2000 });
  if (!published.length) {
    console.error("No published articles in the store. Run scripts/kb-migrate.ts first.");
    process.exit(1);
  }

  console.log("Resetting index…");
  await resetIndex();

  const docs: VectorDoc[] = published.map((a) => ({
    id: a.id,
    title: a.title,
    url: a.url,
    body: a.body,
    source: a.source,
  }));

  console.log(`Ingesting ${docs.length} published articles…`);
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
