/**
 * Offline checks for the self-review's pure parts. No network, no Redis.
 *   npx tsx scripts/self-review-test.mts
 */
import assert from "node:assert/strict";
import { assessCrons, assessRuns, everyMinutes, reliabilityFlags, assessEvents } from "../lib/self-review/reliability";
import { finalVerdict, type JudgementResult, judgeable, kindOf, replyOf, ruleChecks, urlsIn } from "../lib/self-review/quality";
import { buildQuality, pickRuns } from "../lib/self-review";
import type { RunLog } from "../lib/kv";
import type { JudgedReply } from "../lib/self-review/types";

const NOW = Date.parse("2026-11-04T12:00:00Z");
let passed = 0;
const t = async (name: string, fn: () => void | Promise<void>) => {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
};

const run = (o: Partial<RunLog>): RunLog => ({
  id: crypto.randomUUID(),
  at: Math.floor(NOW / 1000) - 3600,
  source: "jettachat",
  ticketId: "c1",
  channel: "jettachat",
  product: "getsign",
  model: "z-ai/glm-5.2",
  dryRun: false,
  replied: true,
  resolutionSent: false,
  escalated: false,
  durationMs: 20_000,
  reply: "Here is how to do it.",
  kbHits: [],
  trace: [],
  ...o,
});

await t("schedule parsing", () => {
  assert.equal(everyMinutes("* * * * *"), 1);
  assert.equal(everyMinutes("*/5 * * * *"), 5);
  assert.equal(everyMinutes("45 * * * *"), 60);
  assert.equal(everyMinutes("0 9 * * *"), 1440);
});

await t("crons: ok, late, failing, unknown", () => {
  const crons = assessCrons(
    {
      "first-response": { at: NOW - 30_000, ms: 100, status: 200, okAt: NOW - 30_000, failStreak: 0 },
      "ticket-sync": { at: NOW - 3 * 3600_000, ms: 100, status: 200, failStreak: 0 },
      "error-watch": { at: NOW - 600_000, ms: 100, status: 500, failStreak: 2, lastError: "HTTP 500" },
    },
    NOW,
  );
  const by = Object.fromEntries(crons.map((c) => [c.name, c.state]));
  assert.equal(by["first-response"], "ok");
  assert.equal(by["ticket-sync"], "late");
  assert.equal(by["error-watch"], "failing");
  assert.equal(by["kb-sync"], "unknown");
});

await t("runs: error spike flags, normal day does not", () => {
  const old = Array.from({ length: 60 }, (_, i) => run({ at: Math.floor(NOW / 1000) - 86400 - i * 7200 }));
  const calm = assessRuns([...Array.from({ length: 20 }, () => run({})), ...old], NOW);
  const base = { computedAt: NOW, crons: [], events: { errors24h: 0, warns24h: 0, spanHours: 0, top: [] } };
  assert.equal(reliabilityFlags({ ...base, runs: calm }).length, 0);
  const bad = assessRuns([...Array.from({ length: 20 }, (_, i) => run({ error: i < 5 ? "boom" : undefined })), ...old], NOW);
  assert.ok(reliabilityFlags({ ...base, runs: bad }).some((f) => f.key === "runs-errors"));
  const quiet = assessRuns([run({}), ...old], NOW);
  assert.ok(reliabilityFlags({ ...base, runs: quiet }).some((f) => f.key === "runs-quiet"));
});

await t("events: a new error type is flagged", () => {
  const ev = (event: string, at: number) => ({ id: event + at, at, level: "error" as const, event, source: "cron" as const });
  const events = [
    ...Array.from({ length: 4 }, (_, i) => ev("x.new_failure", NOW - i * 1000)),
    ...Array.from({ length: 5 }, (_, i) => ev("x.old", NOW - 2 * 86400_000 - i * 1000)),
  ];
  const e = assessEvents(events, NOW);
  assert.ok(e.top.find((x) => x.event === "x.new_failure")?.isNew);
  const flags = reliabilityFlags({ computedAt: NOW, crons: [], runs: assessRuns([], NOW), events: e });
  assert.ok(flags.some((f) => f.key === "event-new:x.new_failure"));
});

await t("reply extraction: email needs reply_to_ticket, chat uses the text", () => {
  assert.equal(replyOf(run({})), "Here is how to do it.");
  const email = run({ channel: "freshdesk", source: "webhook", reply: "No action needed." });
  assert.equal(replyOf(email), null);
  assert.equal(judgeable(email), false);
  const drafted = run({ channel: "freshdesk", source: "webhook", trace: [{ tool: "reply_to_ticket", input: { body: "Hi Ann, ..." }, result: "ok" }] });
  assert.equal(replyOf(drafted), "Hi Ann, ...");
  assert.equal(kindOf(drafted), "email");
  assert.equal(kindOf(run({ source: "devboard", channel: "freshdesk" })), "dev_bridge");
  assert.equal(judgeable(run({ error: "x" })), false);
});

await t("rule checks: internal link is blocking, unsourced link is a warning", async () => {
  const leak = await ruleChecks("email", "See https://jetpackteam.slack.com/archives/x for details on this one.", "", "", { checkLinks: false });
  assert.ok(leak.includes("internal_link"));
  const made = await ruleChecks("chat", "Read https://help.getsign.app/made-up-article", "evidence without it", "", { checkLinks: false });
  assert.ok(made.some((c) => c.startsWith("link_not_in_evidence")));
  const ok = await ruleChecks("chat", "Read https://help.getsign.app/real", "… https://help.getsign.app/real …", "", { checkLinks: false });
  assert.deepEqual(ok, []);
  assert.deepEqual(urlsIn("a https://x.io/a. b https://x.io/a"), ["https://x.io/a"]);
});

await t("final verdict: the worse of score and verdict; a blocking check is bad", () => {
  const j: JudgementResult = { answered: "yes", grounded: "yes", issues: [], score: 4, verdict: "good", summary: "", fixType: "none", fix: "" };
  assert.equal(finalVerdict({ ...j }, []).verdict, "good");
  assert.equal(finalVerdict({ ...j, score: 3, verdict: "bad" }, []).verdict, "bad");
  assert.equal(finalVerdict({ ...j, score: 2, verdict: "good" }, []).verdict, "bad");
  const leaked = finalVerdict({ ...j }, ["ticket_number"]);
  assert.equal(leaked.verdict, "bad");
  assert.ok(leaked.issues.some((i) => i.category === "internal_leak"));
  assert.equal(finalVerdict({ ...j }, ["long_for_chat"]).verdict, "good");
});

await t("pickRuns: chat first, skips judged, two per conversation a day", () => {
  const a = run({ ticketId: "c1" });
  const b = run({ ticketId: "c1", at: a.at - 10 });
  const c = run({ ticketId: "c1", at: a.at - 20 });
  const e = run({ ticketId: "1234", channel: "freshdesk", source: "webhook", trace: [{ tool: "reply_to_ticket", input: { body: "Hello there" }, result: "" }] });
  const picked = pickRuns([e, a, b, c], [], NOW, 10);
  assert.deepEqual(picked.map((x) => x.id), [a.id, b.id, e.id]);
  const judged = [{ runId: a.id, ticketId: "c1", day: "2026-11-04" } as JudgedReply];
  assert.ok(!pickRuns([a], judged, NOW, 10).length);
});

await t("quality rollup", () => {
  const row = (score: number, verdict: JudgedReply["verdict"], fixType: JudgedReply["fixType"] = "none"): JudgedReply =>
    ({ runId: crypto.randomUUID(), at: NOW, judgedAt: NOW, day: "2026-11-04", kind: "chat", ticketId: "c", score, verdict, issues: verdict === "good" ? [] : [{ category: "unsupported_claim", detail: "" }], fixType, fix: fixType === "none" ? "" : "Add X to KB" }) as JudgedReply;
  const q = buildQuality([row(5, "good"), row(2, "bad", "kb_gap"), row(3, "weak", "kb_gap")], NOW);
  const today = q.days.find((d) => d.day === "2026-11-04")!;
  assert.equal(today.judged, 3);
  assert.equal(today.bad, 1);
  assert.equal(today.avgScore, 3.33);
  assert.equal(q.fixes[0].type, "kb_gap");
  assert.equal(q.fixes[0].count, 2);
  assert.equal(q.issues[0].count, 2);
});

console.log(`\n${passed} passed`);

// ── action rules ────────────────────────────────────────────────────
const { assessActions } = await import("../lib/self-review/actions");
const { judgedOn } = await import("../lib/self-review");
const tr = (tool: string, input: Record<string, unknown>, result: string) => ({ tool, input, result });
const H = 3600;

await t("actions: duplicate items, post burst, close after escalation, thin item, cancel", () => {
  const base = Math.floor(NOW / 1000);
  const logs = [
    run({ ticketId: "14457", channel: "freshdesk", source: "webhook", at: base - 30 * H, trace: [tr("create_dev_item", { title: "Sync broken", repro_steps: "1. open board 2. click sync 3. nothing happens on large boards" }, "Created Dev board item \"Sync broken\".")] }),
    run({ ticketId: "14457", channel: "freshdesk", source: "devboard", at: base - 2 * H, trace: [tr("create_dev_item", { title: "Sync broken again", repro_steps: "n/a" }, "Created Dev board item \"Sync broken again\".")] }),
    run({ ticketId: "14591", channel: "freshdesk", source: "devboard", at: base - 5 * H, trace: [tr("reply_on_dev_item", { message: "a" }, "Posted on dev item \"X\" (@Shreya).")] }),
    run({ ticketId: "14591", channel: "freshdesk", source: "devboard", at: base - 4 * H, trace: [tr("reply_on_dev_item", { message: "b" }, "Posted on dev item \"X\" (@Shreya).")] }),
    run({ ticketId: "14591", channel: "freshdesk", source: "devboard", at: base - 3 * H, trace: [tr("reply_on_dev_item", { message: "The customer confirmed the template ID is 12345 and it fails on save." }, "Posted on dev item \"X\" (@Shreya).")] }),
    run({ ticketId: "14591", channel: "freshdesk", source: "devboard", at: base - 2 * H, trace: [tr("reply_on_dev_item", { message: "The customer confirmed the template ID is 12345 and it fails on save!" }, "Posted on dev item \"X\" (@Shreya).")] }),
    run({ ticketId: "14453", channel: "freshdesk", source: "webhook", at: base - 20 * H, heldCustomerWrites: true, trace: [tr("send_escalation", {}, "Escalated.")] }),
    run({ ticketId: "14453", channel: "freshdesk", source: "cron", at: base - 1 * H, trace: [tr("close_ticket", {}, "Ticket marked resolved.")] }),
    // A held close (draft mode) and a chat close are not real closes.
    run({ ticketId: "200", channel: "freshdesk", source: "webhook", heldCustomerWrites: true, trace: [tr("send_escalation", {}, "x"), tr("close_ticket", {}, "Ticket marked resolved.")] }),
    run({ ticketId: "300", channel: "freshdesk", source: "webhook", trace: [tr("cancel_subscription", {}, "Subscription cancelled. Access ends 2026-12-01.")] }),
    run({ ticketId: "301", channel: "freshdesk", source: "webhook", trace: [tr("cancel_subscription", {}, "Billing system is NOT connected — nothing was cancelled.")] }),
    // Deduped onto an existing item: not a second filing.
    run({ ticketId: "400", channel: "freshdesk", source: "webhook", trace: [tr("create_dev_item", { title: "A", repro_steps: "long enough repro steps for a developer to start" }, "Created Dev board item \"A\".")] }),
    run({ ticketId: "400", channel: "freshdesk", source: "webhook", trace: [tr("create_dev_item", { title: "A", repro_steps: "x" }, "This ticket ALREADY has Dev board item \"A\" — added as a comment.")] }),
  ];
  const a = assessActions(logs, NOW);
  const rules = a.findings.map((f) => `${f.rule}:${f.ticketId}`).sort();
  assert.deepEqual(rules, [
    "cancelled_subscription:300",
    "closed_while_escalated:14453",
    "duplicate_dev_item:14457",
    "repeated_dev_post:14591",
    "thin_dev_item:14457",
  ]);
  assert.equal(a.counts.devItemsFiled, 3);
  assert.equal(a.counts.dedupedOntoExisting, 1);
  assert.equal(a.counts.devPosts, 4);
  assert.equal(a.counts.closes, 1);
  assert.equal(a.findings[0].severity, "bad");
});

await t("daily cap counts by when the judge ran", () => {
  const rows = [
    { judgedAt: NOW, day: "2026-11-03" },
    { judgedAt: NOW - 3 * 86400_000, day: "2026-11-01" },
  ] as JudgedReply[];
  assert.equal(judgedOn(rows, "2026-11-04"), 1);
});

console.log(`\n${passed} passed (with action rules)`);
