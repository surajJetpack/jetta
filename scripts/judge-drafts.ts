/**
 * Judge reconciled drafts: was Jetta's suggestion actually better or worse than
 * what the human sent, and if worse, for a reason she can act on?
 *
 * Adoption (used / edited / not used) comes from reconciliation. This adds the
 * two axes reconciliation can't see: a blind quality verdict, and whether the
 * customer came back afterwards. Only losses for fixable reasons are queued for
 * the distiller — everything else is recorded with `distilled: true` so it shows
 * up in reporting without teaching Jetta to imitate a worse reply.
 *
 * DRY RUN BY DEFAULT.
 *
 *   npx tsx --env-file=.env.local scripts/judge-drafts.ts --limit 10
 *   npx tsx --env-file=.env.local scripts/judge-drafts.ts --commit
 */
import { listReplyDrafts } from "../lib/kv";
import { recordEvaluation } from "../lib/evals";
import { judgeDraftPair, type Judgement } from "../lib/judge";
import { fd, getTicketDetails } from "../lib/tools/freshdesk";

const commit = process.argv.includes("--commit");
const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg === -1 ? Infinity : Number(process.argv[limitArg + 1]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Did the customer come back after this reply? Objective, whoever wrote it. */
async function outcomeFor(ticketId: string): Promise<{ reopened: boolean; resolved: boolean }> {
  const t = await fd<{ stats?: { reopened_at?: string; resolved_at?: string } }>(
    `/tickets/${ticketId}?include=stats`,
  );
  return { reopened: !!t.stats?.reopened_at, resolved: !!t.stats?.resolved_at };
}

async function main() {
  const drafts = (await listReplyDrafts())
    .filter((d) => d.agentReply && d.usage)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, LIMIT === Infinity ? undefined : LIMIT);

  console.log(`reconciled drafts with a human reply to compare: ${drafts.length}`);
  console.log(commit ? "COMMIT — writes evaluations\n" : "DRY RUN — writes nothing\n");
  if (!drafts.length) {
    console.log("Nothing to judge yet. Run scripts/backfill-reconcile.ts --commit first.");
    return;
  }

  const tally = { jetta: 0, human: 0, tie: 0 };
  const reasons: Record<string, number> = {};
  const rows: { ticketId: string; usage: string; j: Judgement; reopened: boolean }[] = [];

  for (const [i, d] of drafts.entries()) {
    // The customer's own words are what both replies were answering.
    const ticket = await getTicketDetails(d.ticketId);
    const lastCustomer =
      [...ticket.replies].reverse().find((r) => r.author === "customer" && !r.isPrivate)?.body ??
      ticket.description;

    const j = await judgeDraftPair({
      customerMessage: lastCustomer,
      jettaReply: d.suggestedReply,
      humanReply: d.agentReply!,
      // Alternate presentation order to cancel position bias.
      jettaFirst: i % 2 === 0,
    });
    const outcome = await outcomeFor(d.ticketId).catch(() => ({ reopened: false, resolved: false }));

    tally[j.winner]++;
    if (j.winner === "human") reasons[j.reason] = (reasons[j.reason] ?? 0) + 1;
    rows.push({ ticketId: d.ticketId, usage: d.usage!, j, reopened: outcome.reopened });

    console.log(
      `[${String(i + 1).padStart(3)}/${drafts.length}] ${d.ticketId.padEnd(6)} ` +
        `usage=${d.usage!.padEnd(11)} winner=${j.winner.padEnd(6)} ` +
        `${j.winner === "human" ? j.reason.padEnd(28) : "".padEnd(28)} ` +
        `${j.learnable ? "LEARNABLE" : "-".padEnd(9)} ${outcome.reopened ? "reopened" : ""}`,
    );

    if (commit) {
      await recordEvaluation({
        id: d.id,
        ticketId: d.ticketId,
        subject: d.subject,
        channel: d.channel,
        product: d.product,
        model: d.model,
        decidedBy: `${d.decidedBy ?? "freshdesk"} · blind judge`,
        at: Math.floor(Date.now() / 1000),
        action: d.usage === "not_used" ? "discard" : "approve",
        // Rating is the QUALITY verdict now, not the similarity score.
        rating: j.winner === "human" ? "bad" : j.winner === "tie" ? "partial" : "good",
        tags: j.tags,
        note:
          `usage=${d.usage} similarity=${d.similarity} · blind judge: ${j.winner} won` +
          `${j.winner === "human" ? ` (${j.reason})` : ""}` +
          `${outcome.reopened ? " · ticket reopened after" : ""} · ${j.explanation}`,
        suggestedReply: d.suggestedReply,
        finalBody: d.agentReply,
        source: "reconcile",
        // Pre-marking as distilled keeps it out of the distiller's queue: only
        // fixable losses should shape the prompt.
        distilled: !j.learnable,
      }).catch((e) => console.warn(`  record failed for ${d.id}: ${e}`));
    }

    await sleep(400);
  }

  const n = rows.length;
  const pc = (x: number) => `${((x / n) * 100).toFixed(0)}%`;
  console.log(`\n=== blind quality verdict (n=${n}) ===`);
  console.log(`  Jetta better: ${tally.jetta} (${pc(tally.jetta)})`);
  console.log(`  Human better: ${tally.human} (${pc(tally.human)})`);
  console.log(`  Tie:          ${tally.tie} (${pc(tally.tie)})`);

  console.log(`\n=== why Jetta lost ===`);
  for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(30)} ${v}`);

  const learnable = rows.filter((r) => r.j.learnable).length;
  console.log(`\nlearnable (queued for the distiller): ${learnable} of ${n}`);
  console.log(`not learnable (recorded, excluded):   ${n - learnable}`);

  console.log(`\n=== adoption vs quality ===`);
  for (const usage of ["used_as_is", "edited", "not_used"]) {
    const set = rows.filter((r) => r.usage === usage);
    if (!set.length) continue;
    const jettaWon = set.filter((r) => r.j.winner === "jetta").length;
    console.log(`  ${usage.padEnd(11)} n=${String(set.length).padStart(3)}  Jetta judged better in ${jettaWon} (${((jettaWon / set.length) * 100).toFixed(0)}%)`);
  }

  const reopened = rows.filter((r) => r.reopened).length;
  console.log(`\ntickets reopened after the sent reply: ${reopened} (${pc(reopened)})`);
  if (!commit) console.log(`\nDry run — nothing written.`);
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
