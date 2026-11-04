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
    ({ runId: crypto.randomUUID(), at: NOW, day: "2026-11-04", kind: "chat", ticketId: "c", score, verdict, issues: verdict === "good" ? [] : [{ category: "unsupported_claim", detail: "" }], fixType, fix: fixType === "none" ? "" : "Add X to KB" }) as JudgedReply;
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
