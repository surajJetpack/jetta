/**
 * One-off backfill: judge every pending draft against what the agent actually
 * sent, so a month of real outcomes lands in the eval loop at once instead of
 * accumulating over the next month.
 *
 * DRY RUN BY DEFAULT — prints the verdict distribution and a sample of each
 * class, writing nothing. Re-run with --commit once the classifications look
 * right; that writes draft states and evaluations, which feed /evals.
 *
 *   npx tsx --env-file=.env.local scripts/backfill-reconcile.ts
 *   npx tsx --env-file=.env.local scripts/backfill-reconcile.ts --commit
 *   npx tsx --env-file=.env.local scripts/backfill-reconcile.ts --limit 20
 */
import { listReplyDrafts, getReplyDraft } from "../lib/kv";
import { reconcileTicketDraft, type ReconcileResult } from "../lib/reconcile";

const commit = process.argv.includes("--commit");
const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg === -1 ? Infinity : Number(process.argv[limitArg + 1]);
/** Freshdesk rate limits bit us once already; this runs slow on purpose. */
const PACE_MS = 700;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const all = await listReplyDrafts();
  const pending = all
    .filter((d) => d.state === "pending" && d.channel === "freshdesk")
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, LIMIT === Infinity ? undefined : LIMIT);

  console.log(`drafts total: ${all.length}`);
  console.log(`  by state: ${Object.entries(all.reduce<Record<string, number>>((acc, d) => ((acc[d.state] = (acc[d.state] ?? 0) + 1), acc), {})).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  console.log(`\nreconciling ${pending.length} pending freshdesk drafts — ${commit ? "COMMIT (writes evaluations)" : "DRY RUN (writes nothing)"}\n`);

  const results: ReconcileResult[] = [];
  for (const [i, d] of pending.entries()) {
    const r = await reconcileTicketDraft(d.ticketId, { source: "cron", commit });
    results.push(r);
    const age = ((Date.now() / 1000 - d.createdAt) / 86400).toFixed(1);
    process.stdout.write(
      `[${String(i + 1).padStart(3)}/${pending.length}] ticket ${d.ticketId.padEnd(6)} age ${age.padStart(5)}d  ` +
        `${r.status}${r.rating ? ` → ${r.rating} (${r.score?.toFixed(2)})` : ""}\n`,
    );
    await sleep(PACE_MS);
  }

  const by = (k: keyof ReconcileResult) =>
    results.reduce<Record<string, number>>((acc, r) => {
      const v = String(r[k] ?? "-");
      acc[v] = (acc[v] ?? 0) + 1;
      return acc;
    }, {});

  console.log(`\n=== status ===`);
  for (const [k, v] of Object.entries(by("status")).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(18)} ${v}`);
  console.log(`=== rating (of those reconciled) ===`);
  for (const [k, v] of Object.entries(by("rating")).sort((a, b) => b[1] - a[1])) {
    if (k !== "-") console.log(`  ${k.padEnd(18)} ${v}`);
  }

  // A verdict is only trustworthy if the text pairs look right — print one of each.
  console.log(`\n=== samples (verify these before --commit) ===`);
  for (const rating of ["good", "partial", "bad"] as const) {
    const hit = results.find((r) => r.rating === rating);
    if (!hit?.draftId) continue;
    const d = await getReplyDraft(hit.draftId);
    console.log(`\n--- ${rating.toUpperCase()} (score ${hit.score?.toFixed(2)}) ticket ${hit.ticketId}`);
    console.log(`  JETTA:  ${(d?.suggestedReply ?? "").replace(/\s+/g, " ").slice(0, 220)}`);
  }

  if (!commit) console.log(`\nDry run — nothing written. Re-run with --commit to record these.`);
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
