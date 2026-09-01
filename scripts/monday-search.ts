/**
 * Probe the dev-board matcher: what does a given symptom actually match, and
 * how sure is it?
 *
 * The matcher decides whether Jetta files a new item or tells the team (and
 * the customer) that a bug is already tracked, so it is worth being able to
 * ask it directly — a wrong "strong" is how one customer's report ends up
 * attached to somebody else's month-old item.
 *
 *   npx tsx --env-file=.env.local scripts/monday-search.ts "signed document syncing" getsign
 */
import { searchDevBoard } from "../lib/tools/monday";
import type { Product } from "../lib/types";

async function main() {
  const symptom = process.argv[2] ?? "signed document syncing";
  const product = (process.argv[3] as Product) ?? "getsign";
  const hits = await searchDevBoard(symptom, product);
  console.log(`[${product}] "${symptom}" — ${hits.length} hit(s)\n`);
  if (!hits.length) {
    console.log("No match. Jetta files a new item — the safe outcome, not a failure.");
    return;
  }
  for (const h of hits) {
    console.log(
      `${h.confidence === "strong" ? "STRONG  " : "possible"} ${String(h.matchScore).padEnd(5)} ${h.state?.padEnd(6)} ${h.title}`,
    );
    console.log(`         group: ${h.group ?? "?"} · status: ${h.status} · ${h.url}\n`);
  }
}
main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
