/**
 * Does length explain why drafts aren't used?
 *
 * Adoption is the one robust finding so far: 0 of 27 drafts were sent as-is, and
 * Jetta writes ~1000 characters where the team sends ~200. The blind judge can't
 * settle it — LLM judges reward thoroughness, which is exactly the trait the team
 * is rejecting.
 *
 * So test it against revealed preference instead of opinion: rewrite each draft to
 * the team's own house length, then measure whether it lands CLOSER to the reply
 * the agent actually sent. If terseness was the blocker, similarity should rise
 * sharply. If it barely moves, the divergence is about content, not length, and
 * shortening the prompt won't buy adoption.
 *
 * Read-only apart from LLM calls: writes nothing, changes no drafts.
 *
 *   npx tsx --env-file=.env.local scripts/concise-variant-test.ts --limit 12
 */
import { generateText } from "ai";
import { listReplyDrafts } from "../lib/kv";
import { getModel } from "../lib/llm";
import { normalizeReplyText, replySimilarity } from "../lib/reply-similarity";

const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg === -1 ? 12 : Number(process.argv[limitArg + 1]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

async function shorten(draft: string, targetChars: number): Promise<string> {
  const { text } = await generateText({
    model: getModel("standard"),
    system:
      `Rewrite this support reply to about ${targetChars} characters. Keep the actual answer, the specific ` +
      `instruction, and any question you need the customer to answer. Cut greetings beyond one line, ` +
      `restatements of the customer's problem, explanations of what you did internally, and reassurance padding. ` +
      `Plain sentences, no headings, no bullet lists unless there are genuinely discrete steps. ` +
      `Output only the rewritten reply.`,
    prompt: draft,
  });
  return text.trim();
}

async function main() {
  const drafts = (await listReplyDrafts())
    .filter((d) => d.agentReply && d.usage && d.suggestedReply)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, LIMIT);

  if (!drafts.length) {
    console.log("No reconciled drafts available. Run scripts/backfill-reconcile.ts --commit first.");
    return;
  }

  // The team's house length, measured rather than assumed.
  const humanLens = drafts.map((d) => d.agentReply!.length);
  const jettaLens = drafts.map((d) => d.suggestedReply.length);
  const target = Math.round(median(humanLens));
  console.log(`pairs: ${drafts.length}`);
  console.log(`jetta draft length:  median ${median(jettaLens)}  mean ${mean(jettaLens).toFixed(0)}`);
  console.log(`human reply length:  median ${median(humanLens)}  mean ${mean(humanLens).toFixed(0)}`);
  console.log(`=> rewriting to ~${target} chars (the team's median)\n`);

  const rows: { ticketId: string; before: number; after: number; lenBefore: number; lenAfter: number }[] = [];
  for (const [i, d] of drafts.entries()) {
    const concise = await shorten(d.suggestedReply, target);
    const human = normalizeReplyText(d.agentReply!);
    const before = replySimilarity(normalizeReplyText(d.suggestedReply), human);
    const after = replySimilarity(normalizeReplyText(concise), human);
    rows.push({
      ticketId: d.ticketId,
      before,
      after,
      lenBefore: d.suggestedReply.length,
      lenAfter: concise.length,
    });
    console.log(
      `[${String(i + 1).padStart(2)}/${drafts.length}] ${d.ticketId.padEnd(6)} ` +
        `${String(d.suggestedReply.length).padStart(5)}ch → ${String(concise.length).padStart(4)}ch   ` +
        `similarity ${before.toFixed(2)} → ${after.toFixed(2)}  ${after > before ? "+" : ""}${(after - before).toFixed(2)}`,
    );
    await sleep(300);
  }

  const befores = rows.map((r) => r.before);
  const afters = rows.map((r) => r.after);
  const improved = rows.filter((r) => r.after > r.before).length;
  console.log(`\n=== similarity to the reply the agent actually sent ===`);
  console.log(`  original draft:  mean ${mean(befores).toFixed(3)}  median ${median(befores).toFixed(3)}`);
  console.log(`  concise variant: mean ${mean(afters).toFixed(3)}  median ${median(afters).toFixed(3)}`);
  console.log(`  improved in ${improved}/${rows.length} cases`);
  console.log(`\n  length: ${mean(rows.map((r) => r.lenBefore)).toFixed(0)}ch → ${mean(rows.map((r) => r.lenAfter)).toFixed(0)}ch`);

  const lift = mean(afters) - mean(befores);
  console.log(
    `\nverdict: ${
      lift > 0.15
        ? "length looks like a real driver — worth an A/B on live tickets"
        : lift > 0.05
          ? "small effect — length is part of it, not the whole story"
          : "length is NOT the blocker; the divergence is about content"
    } (mean lift ${lift >= 0 ? "+" : ""}${lift.toFixed(3)})`,
  );
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
