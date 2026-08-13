/**
 * Sanity check for the emerging-issue maths behind /today, on synthetic data —
 * no KV, no LLM, no env needed:
 *
 *   npx tsx scripts/topics-test.ts
 *
 * The cases below are the ones that decide whether the morning brief is worth
 * reading: a real spike must surface, steady background noise must not, and a
 * cold start must refuse to call everything a spike.
 */
import { normalizeTopic, topicTrends, topicCounts, ticketRecords } from "../lib/topics";
import type { OutcomeEvent } from "../lib/kv";

const NOW = Date.UTC(2026, 7, 13, 9, 0, 0); // fixed clock — no Date.now() drift
const nowS = Math.floor(NOW / 1000);
const HOUR = 3600;
const DAY = 86400;

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}

let seq = 0;
function ev(topic: string | undefined, agoS: number, over: Partial<OutcomeEvent> = {}): OutcomeEvent {
  return {
    ticketId: over.ticketId ?? `t${++seq}`,
    subject: `subject ${seq}`,
    at: nowS - agoS,
    channel: "freshdesk",
    product: "getsign",
    topic,
    model: "test",
    toolsUsed: [],
    replied: true,
    resolutionSent: false,
    escalated: false,
    kind: "handled",
    ...over,
  };
}

console.log("\nnormalizeTopic");
check("lowercases and collapses whitespace", normalizeTopic("  Signing   Link  Expired "), "signing link expired");
check("strips trailing punctuation", normalizeTopic("signing link expired."), "signing link expired");
check("drops shapeless labels", normalizeTopic("Other"), null);
check("drops empty", normalizeTopic(""), null);
// The garbage-can family, in every phrasing the model reached for live.
check("drops 'general help'", normalizeTopic("General help"), null);
check("drops 'help needed'", normalizeTopic("Help needed"), null);
check("drops 'technical issue'", normalizeTopic("technical issue"), null);
check("drops 'customer support request'", normalizeTopic("customer support request"), null);
// …but one meaningful word is enough to keep a label.
check("keeps 'billing question'", normalizeTopic("Billing question"), "billing question");
check("keeps 'trial extension request'", normalizeTopic("trial extension request"), "trial extension request");
check("keeps 'account access'", normalizeTopic("account access"), "account access");
check("keeps a single meaningful word", normalizeTopic("webhooks"), "webhooks");
check("caps at five words", normalizeTopic("one two three four five six"), "one two three four five");

console.log("\ntopicTrends — a real spike against a steady baseline");
{
  const events: OutcomeEvent[] = [];
  // Background: "invoice question" runs at 2/day for a fortnight. Offset a few
  // hours so no event lands exactly on the window boundary and drifts between
  // "baseline" and "recent" depending on the hour the brief is read.
  for (let d = 1; d <= 14; d++) {
    for (let i = 0; i < 2; i++) events.push(ev("invoice question", d * DAY + 4 * HOUR + i * HOUR));
  }
  // Background: "signing link expired" at 1/day.
  for (let d = 1; d <= 14; d++) events.push(ev("signing link expired", d * DAY + 2 * HOUR));
  // Overnight: signing links blow up (9), invoices stay normal (2).
  for (let i = 0; i < 9; i++) events.push(ev("signing link expired", i * HOUR));
  for (let i = 0; i < 2; i++) events.push(ev("invoice question", i * HOUR));

  const t = topicTrends(events, { nowMs: NOW });
  check("history is deep enough to judge", t.partialHistory, false);
  check("only the spiking topic is emerging", t.emerging.map((e) => e.topic), ["signing link expired"]);
  check("counts distinct tickets in the window", t.emerging[0].recent, 9);
  check("baseline is the mean daily rate", t.emerging[0].baselinePerDay, 1);
  check("multiplier is recent ÷ baseline", t.emerging[0].multiplier, 9);
  check("steady topic is not flagged", t.top.some((x) => x.topic === "invoice question"), true);
}

console.log("\ntopicTrends — a common topic having an ordinary day (the low-volume trap)");
{
  // Real traffic is ~13 tickets/day over ~40 topics, so most topics score 0 on
  // most days. Under a MEDIAN baseline every one of them reads as 0/day, every
  // multiplier collapses to the same number, and "product purchase" — 14% of
  // all tickets — was reported as a 6× spike on an unremarkable day.
  const events: OutcomeEvent[] = [];
  for (let d = 1; d <= 14; d++) {
    // ~0.8/day, but arriving in clumps: nothing at all on 6 of the 14 days.
    if (d % 7 === 0) continue;
    events.push(ev("product purchase", d * DAY + 4 * HOUR));
    if (d % 3 === 0) events.push(ev("product purchase", d * DAY + 5 * HOUR));
  }
  for (let i = 0; i < 3; i++) events.push(ev("product purchase", i * HOUR));

  const t = topicTrends(events, { nowMs: NOW });
  const trend = t.top.find((x) => x.topic === "product purchase")!;
  check("keeps the fractional rate a median would flatten to 0", trend.baselinePerDay! > 0.5, true);
  check("an ordinary busy day is not a spike", t.emerging.length, 0);
}

console.log("\ntopicTrends — noise control");
{
  const events: OutcomeEvent[] = [];
  for (let d = 1; d <= 14; d++) events.push(ev("password reset", d * DAY));
  // Two tickets on a never-before-seen topic: real, but below the floor.
  events.push(ev("weird new thing", 2 * HOUR));
  events.push(ev("weird new thing", 3 * HOUR));

  const t = topicTrends(events, { nowMs: NOW });
  check("a 2-ticket novelty stays off the brief", t.emerging.length, 0);

  // A third makes it worth someone's morning.
  events.push(ev("weird new thing", 4 * HOUR));
  const t2 = topicTrends(events, { nowMs: NOW });
  check("a 3-ticket novelty surfaces", t2.emerging.map((e) => e.topic), ["weird new thing"]);
  check("flagged as new, not as a multiple", t2.emerging[0].isNew, true);
}

console.log("\ntopicTrends — the same ticket handled repeatedly");
{
  const events = [
    ev("board column mapping", 1 * HOUR, { ticketId: "555" }),
    ev("board column mapping", 2 * HOUR, { ticketId: "555" }),
    ev("board column mapping", 3 * HOUR, { ticketId: "555" }),
    ev("board column mapping", 4 * HOUR, { ticketId: "555" }),
  ];
  for (let d = 1; d <= 14; d++) events.push(ev("board column mapping", d * DAY));
  const t = topicTrends(events, { nowMs: NOW });
  check("four runs on one ticket count once", t.emerging.length, 0);
}

console.log("\ntopicTrends — a backlog worked this morning is not this morning's traffic");
{
  // Measured against the live feed: 61 of 84 outcomes in a 24h window were
  // approvals of month-old drafts. Dating those to now would invent a spike
  // out of a reviewer clearing their queue.
  const events: OutcomeEvent[] = [];
  for (let d = 1; d <= 14; d++) events.push(ev("vlookup sync failure", d * DAY));
  for (let i = 0; i < 10; i++) {
    const id = `old${i}`;
    events.push(ev("vlookup sync failure", 10 * DAY, { ticketId: id })); // arrived 10 days ago
    events.push(ev("vlookup sync failure", 1 * HOUR, { ticketId: id, replied: true, drafted: true })); // approved just now
  }
  const t = topicTrends(events, { nowMs: NOW });
  check("approvals don't fake an arrival spike", t.emerging.length, 0);

  const recs = ticketRecords(events);
  const old0 = recs.find((r) => r.ticketId === "old0")!;
  check("ticket is dated by first sighting", old0.at, nowS - 10 * DAY);
  check("but its latest activity is tracked too", old0.lastAt, nowS - HOUR);
  check("and the reply is remembered", old0.replied, true);
}

console.log("\ntopicTrends — cold start");
{
  const events = [ev("signing link expired", 1 * HOUR), ev("signing link expired", 2 * HOUR), ev("signing link expired", 3 * HOUR)];
  const t = topicTrends(events, { nowMs: NOW });
  check("says it can't tell yet", t.partialHistory, true);
  check("still surfaces the volume", t.emerging.length, 1);
  // `?? "missing"` would swallow the null this asserts — index explicitly.
  check("baseline is unknown, not zero", t.emerging.length ? t.emerging[0].baselinePerDay : "missing", null);
  check("no multiplier is claimed without a baseline", t.emerging.length ? t.emerging[0].multiplier : "missing", null);
}

console.log("\ntopicTrends — unlabelled coverage");
{
  const events = [ev(undefined, 1 * HOUR), ev("billing question", 2 * HOUR), ev(undefined, 30 * DAY)];
  const t = topicTrends(events, { nowMs: NOW });
  check("counts unlabelled tickets in the window only", t.unlabelled, 1);
}

console.log("\ntopicCounts");
{
  const events = [
    ev("billing question", HOUR, { ticketId: "1" }),
    ev("billing question", HOUR, { ticketId: "1" }),
    ev("billing question", HOUR, { ticketId: "2" }),
    ev("Signing Link Expired", HOUR, { ticketId: "3" }),
    ev(undefined, HOUR, { ticketId: "4" }),
  ];
  check("dedupes per ticket and normalizes", topicCounts(events), [
    { topic: "billing question", count: 2 },
    { topic: "signing link expired", count: 1 },
  ]);
}

console.log(failures ? `\n${failures} FAILED\n` : "\nall checks passed\n");
process.exit(failures ? 1 : 0);
