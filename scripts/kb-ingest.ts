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
 *
 * Flags:
 *   --no-reset   upsert in place instead of wiping first.
 *
 * ON A LIVE INDEX, PREFER --no-reset. The reset is not free: between the wipe
 * and the last batch, retrieval returns nothing and Jetta answers every
 * question as though the knowledge base were empty. Upserting by the same ids
 * overwrites each document — content and metadata — with no such window. The
 * one thing it cannot do is remove documents that should no longer be there,
 * so the doc count is printed before and after: unchanged means nothing stale
 * was hiding in the index, and a drop of documents you meant to remove is what
 * the full reset is for.
 */
import { listArticles, scopeOf } from "../lib/kb-store";
import { upsertDocs, resetIndex, vectorEnabled, indexInfo, type VectorDoc } from "../lib/vector";

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

  const before = await indexInfo();
  if (before) console.log(`Index holds ${before.vectorCount} documents.`);

  if (process.argv.includes("--no-reset")) {
    console.log("Upserting in place (--no-reset) — the index stays queryable throughout.");
  } else {
    console.log("Resetting index…");
    await resetIndex();
  }

  const docs: VectorDoc[] = published.map((a) => ({
    id: a.id,
    title: a.title,
    url: a.url,
    body: a.body,
    source: a.source,
    // Brand scope travels as index metadata — it is the only thing the
    // retrieval filter can see, so an index ingested without it cannot be
    // filtered. Derived for articles that predate the field.
    product: scopeOf(a),
  }));

  console.log(`Ingesting ${docs.length} published articles…`);
  const BATCH = 25;
  let done = 0;
  for (let i = 0; i < docs.length; i += BATCH) {
    done += await upsertDocs(docs.slice(i, i + BATCH));
    console.log(`  upserted ${done}/${docs.length}`);
  }

  const after = await indexInfo();
  if (before && after) {
    console.log(
      `Index holds ${after.vectorCount} documents (was ${before.vectorCount}).` +
        (after.vectorCount === before.vectorCount
          ? " Unchanged — every document was overwritten in place."
          : ` ${Math.abs(after.vectorCount - before.vectorCount)} ${
              after.vectorCount > before.vectorCount ? "added" : "removed"
            }.`),
    );
  }
  console.log("Done.");
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
