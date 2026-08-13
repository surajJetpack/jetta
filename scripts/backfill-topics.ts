/**
 * One-off backfill: label the outcome feed's existing tickets with topics, so
 * the morning brief (/today) has a baseline to compare against on day one.
 *
 * Without this, every topic is brand new the morning the feature ships and the
 * emerging-issues list flags all of them — the exact cry-wolf failure the
 * baseline exists to prevent. Labels come from the same light tier the live
 * triage uses, off the subject alone (the feed doesn't keep bodies).
 *
 * DRY RUN BY DEFAULT — prints the topic distribution and writes nothing.
 * Re-run with --commit to rewrite the feed. It rewrites the whole outcome list,
 * so run it when traffic is quiet: a webhook landing mid-rewrite would be lost.
 *
 *   npx tsx --env-file=.env.local scripts/backfill-topics.ts
 *   npx tsx --env-file=.env.local scripts/backfill-topics.ts --commit
 *   npx tsx --env-file=.env.local scripts/backfill-topics.ts --batch 40
 */
import { generateObject } from "ai";
import { z } from "zod";
import { getModel, modelLabel } from "../lib/llm";
import { getOutcomes, replaceOutcomes, recordTopicUse, getKnownTopics, type OutcomeEvent } from "../lib/kv";
import { normalizeTopic, displayTopic } from "../lib/topics";

const commit = process.argv.includes("--commit");
const batchArg = process.argv.indexOf("--batch");
const BATCH = batchArg === -1 ? 25 : Math.max(1, Number(process.argv[batchArg + 1]));

const SYSTEM = `You label customer support tickets with a short topic, so a support team can spot issues trending across many tickets.

For each numbered ticket, return that ticket's number and a topic label:
- 2 to 4 lowercase words naming the specific problem or request: "signing link expired", "invoice vat number", "board column mapping", "trial extension request".
- Name the theme, not this customer's details: no names, emails, ticket numbers, company names or quoted error strings.
- Not a severity or sentiment ("urgent", "angry customer"), and not just the product name.
- Never a label built only from filler words — "general help", "help needed", "technical issue", "customer request" and the like are worthless for spotting trends. Every label must contain at least one word naming a real surface, feature or action.
- If a subject genuinely says nothing about the problem ("Help needed", "Re: Conversation with michael"), name the surface it touches ("account access", "signing document") rather than reaching for filler. Never stretch a vague subject into a specific-sounding label you can't support.
- Reuse a label from the list of topics already in use whenever one fits, EXACTLY as written. Only coin a new label when none of them describes the ticket.

You are working from subject lines alone. A vague subject gets a vague-but-honest label; do not invent specifics that aren't there.
Return one entry for every ticket number given.`;

const Labels = z.object({
  labels: z.array(
    z.object({
      n: z.number().describe("The ticket number as given in the list"),
      topic: z.string().describe("2-4 lowercase words"),
    }),
  ),
});

async function labelBatch(
  batch: { n: number; subject: string; product: string }[],
  taxonomy: string[],
): Promise<Map<number, string>> {
  const system = taxonomy.length
    ? `${SYSTEM}\n\nTopics already in use, most common first:\n${taxonomy.map((t) => `- ${t}`).join("\n")}`
    : SYSTEM;
  const { object } = await generateObject({
    model: getModel("light"),
    schema: Labels,
    system,
    prompt: batch.map((b) => `${b.n}. [${b.product}] ${b.subject}`).join("\n"),
  });
  const out = new Map<number, string>();
  for (const l of object.labels) {
    const topic = normalizeTopic(l.topic);
    if (topic) out.set(l.n, topic);
  }
  return out;
}

async function main() {
  const outcomes = await getOutcomes(1000);
  // Same ticket, many outcomes (drafted → approved → reopened): label the
  // ticket once and stamp every one of its events, so a backfilled ticket
  // counts the same way a live one does.
  const needing = outcomes.filter((o) => !o.topic && (o.subject ?? "").trim().length > 2);
  const bySubject = new Map<string, { subject: string; product: string; events: OutcomeEvent[] }>();
  for (const o of needing) {
    const key = o.ticketId;
    const existing = bySubject.get(key);
    if (existing) existing.events.push(o);
    else bySubject.set(key, { subject: o.subject!.trim(), product: o.product, events: [o] });
  }

  const tickets = [...bySubject.values()];
  const alreadyLabelled = outcomes.filter((o) => o.topic).length;
  console.log(`outcomes in feed:   ${outcomes.length}`);
  console.log(`already labelled:   ${alreadyLabelled}`);
  console.log(`unlabelled tickets: ${tickets.length} (${needing.length} events)`);
  console.log(`skipped (no subject): ${outcomes.filter((o) => !o.topic && !(o.subject ?? "").trim()).length}`);
  if (!tickets.length) {
    console.log("\nnothing to do.");
    return;
  }
  console.log(`\nlabelling with ${modelLabel("light")} in batches of ${BATCH} — ${commit ? "COMMIT" : "DRY RUN"}\n`);

  // Seed from the live taxonomy and grow it as we go, so later batches converge
  // on the labels earlier batches chose instead of re-coining synonyms.
  const taxonomy = new Map<string, number>();
  for (const t of await getKnownTopics(40).catch(() => [])) taxonomy.set(t, 1);

  let labelled = 0;
  for (let i = 0; i < tickets.length; i += BATCH) {
    const slice = tickets.slice(i, i + BATCH);
    const batch = slice.map((t, j) => ({ n: i + j, subject: t.subject, product: t.product }));
    const top = [...taxonomy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([t]) => t);
    let labels: Map<number, string>;
    try {
      labels = await labelBatch(batch, top);
    } catch (e) {
      console.warn(`  batch ${i}-${i + slice.length - 1} failed, skipping:`, e instanceof Error ? e.message : e);
      continue;
    }
    for (const [j, t] of slice.entries()) {
      const topic = labels.get(i + j);
      if (!topic) continue;
      for (const ev of t.events) ev.topic = topic;
      taxonomy.set(topic, (taxonomy.get(topic) ?? 0) + 1);
      labelled++;
    }
    process.stdout.write(`  ${Math.min(i + BATCH, tickets.length)}/${tickets.length} tickets labelled\n`);
  }

  const dist = [...taxonomy.entries()].sort((a, b) => b[1] - a[1]);
  // Print the subjects behind each label: a topic that has swallowed a big
  // share of the feed is usually a garbage-can label, and the only way to tell
  // is to read what fell into it.
  const examples = new Map<string, string[]>();
  for (const t of tickets) {
    const topic = t.events[0]?.topic;
    if (!topic) continue;
    const list = examples.get(topic) ?? [];
    if (list.length < 3) list.push(t.subject);
    examples.set(topic, list);
  }
  console.log(`\nlabelled ${labelled}/${tickets.length} tickets into ${dist.length} topics:\n`);
  for (const [topic, count] of dist.slice(0, 30)) {
    const share = ((count / tickets.length) * 100).toFixed(0);
    console.log(`  ${String(count).padStart(4)}  (${share.padStart(2)}%)  ${displayTopic(topic)}`);
    for (const s of examples.get(topic) ?? []) console.log(`              · ${s.slice(0, 88)}`);
  }
  if (dist.length > 30) console.log(`  … and ${dist.length - 30} more`);

  if (!commit) {
    console.log("\nDRY RUN — nothing written. Re-run with --commit to persist.");
    return;
  }

  // `outcomes` holds the same object references the events were mutated on, so
  // the list is already enriched — write it back in one shot.
  await replaceOutcomes(outcomes);
  for (const [topic, count] of dist) await recordTopicUse(topic, count);
  console.log(`\nCOMMITTED — rewrote ${outcomes.length} outcomes and seeded ${dist.length} topics.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
