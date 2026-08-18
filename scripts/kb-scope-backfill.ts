/**
 * One-off: stamp the brand scope (`product`) onto every stored KB article.
 *
 * Retrieval already works without this — `scopeOf()` derives a scope from an
 * article's origin/source when the field is absent — so the point of writing
 * it down is that a human can then SEE and CHANGE it in the console. An
 * article that should be shared but was crawled from getsign.io stays invisible
 * to the portfolio bot until someone can find it and move it.
 *
 * Safe to re-run: only articles missing the field are touched. The actor is
 * "kb-scope-backfill", which lib/kb-sync.ts counts as a crawler — otherwise
 * this run would mark the entire crawled corpus as human-edited and freeze the
 * daily site sync.
 *
 * AFTER this, re-run scripts/kb-ingest.ts: the vector index carries its own
 * copy of the scope as metadata, and only a re-upsert puts it there.
 *
 *   npx tsx --env-file=.env.local scripts/kb-scope-backfill.ts [--apply]
 *
 * Dry by default — it prints the split it would write and changes nothing.
 */
import { listArticles, updateArticle, scopeOf, type KbArticle } from "../lib/kb-store";

const ACTOR = "kb-scope-backfill";

async function main() {
  const apply = process.argv.includes("--apply");
  const all = await listArticles({ limit: 2000 });
  if (!all.length) {
    console.error("No articles in the store. Nothing to do.");
    process.exit(1);
  }

  const untagged = all.filter((a) => !a.product);
  const tally = new Map<string, number>();
  const bump = (a: KbArticle) => tally.set(scopeOf(a), (tally.get(scopeOf(a)) ?? 0) + 1);
  all.forEach(bump);

  console.log(`${all.length} articles, ${untagged.length} without an explicit scope.`);
  console.log("Scope split (derived where absent):");
  for (const [scope, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${scope.padEnd(12)} ${n}`);
  }

  if (!untagged.length) {
    console.log("Every article already carries a scope. Nothing to write.");
    return;
  }
  if (!apply) {
    console.log(`\nDry run. Re-run with --apply to write ${untagged.length} scopes.`);
    return;
  }

  let done = 0;
  const failed: string[] = [];
  for (const a of untagged) {
    try {
      await updateArticle(a.id, { product: scopeOf(a) }, ACTOR);
      done++;
      if (done % 25 === 0) console.log(`  ${done}/${untagged.length}`);
    } catch (e) {
      failed.push(`${a.id}: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(`Wrote ${done} scopes.${failed.length ? ` ${failed.length} failed:` : ""}`);
  failed.forEach((f) => console.log(`  ${f}`));
  console.log("\nNext: npx tsx --env-file=.env.local scripts/kb-ingest.ts (reindex with metadata).");
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
