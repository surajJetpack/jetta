/**
 * Is Mark told about a compliance request once when it arrives, reminded only
 * after two quiet working days, and left alone when the ball is not with him?
 *
 *   npx tsx scripts/compliance-nudge-test.ts
 *
 * The decisions and the message text only: no network, no storage.
 */
import { complianceNudgeText, decideComplianceNudge, MAX_LINES, MAX_MESSAGES, type NudgeState } from "../lib/compliance-nudge";

export {};

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) console.log(`  ok    ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}\n          expected ${JSON.stringify(expected)}\n          got      ${JSON.stringify(actual)}`);
  }
}

const MARK = "55320719";
const SURAJ = "82879261";
const RULES = { ownerId: MARK, weekend: [6, 0] };
// 2026-10-19 is a Monday.
const iso = (d: number, h = 9) => new Date(Date.UTC(2026, 9, d, h)).toISOString();
const now = (d: number, h = 10) => new Date(Date.UTC(2026, 9, d, h, 5));
const item = (over: Partial<Parameters<typeof decideComplianceNudge>[0]> = {}) => ({
  status: "Pending" as string | null,
  createdAt: iso(19),
  ownerIds: [MARK],
  updates: [] as { at: string; creatorId: string }[],
  ...over,
});
const told = (n: number, d: number): NudgeState => ({ n, at: now(d).toISOString() });

console.log("A new request");
{
  check("filed an hour ago, assigned to Mark: told now", decideComplianceNudge(item(), null, now(19), RULES), { action: "new", n: 1 });
  check("filed by hand with no status yet: still told", decideComplianceNudge(item({ status: null }), null, now(19), RULES).action, "new");
  check("assigned to someone else: nothing", decideComplianceNudge(item({ ownerIds: [SURAJ] }), null, now(19), RULES), { action: "none", reason: "not assigned to him" });
  check("Mark and Suraj both on it: told", decideComplianceNudge(item({ ownerIds: [MARK, SURAJ] }), null, now(19), RULES).action, "new");
  check("filed on Saturday: told on Monday", [
    decideComplianceNudge(item({ createdAt: iso(24) }), null, now(24), RULES),
    decideComplianceNudge(item({ createdAt: iso(24) }), null, now(25), RULES),
    decideComplianceNudge(item({ createdAt: iso(24) }), null, now(26), RULES),
  ], [{ action: "none", reason: "day off" }, { action: "none", reason: "day off" }, { action: "new", n: 1 }]);
  check("an old request never mentioned before comes up as a reminder, not as new", decideComplianceNudge(item({ createdAt: iso(5) }), null, now(19), RULES), { action: "remind", n: 1 });
}

console.log("Not waiting on him");
{
  check("Client Reviewing", decideComplianceNudge(item({ status: "Client Reviewing" }), null, now(19), RULES), { action: "none", reason: "status Client Reviewing" });
  check("Done", decideComplianceNudge(item({ status: "Done" }), told(1, 19), now(23), RULES).action, "none");
  check("Stuck is his", decideComplianceNudge(item({ status: "Stuck" }), null, now(19), RULES).action, "new");
  check("no status and months old: skipped", decideComplianceNudge(item({ status: null, createdAt: new Date(Date.UTC(2026, 5, 1)).toISOString() }), null, now(19), RULES), { action: "none", reason: "old item with no status" });
  check("he wrote last: the ball is with us", decideComplianceNudge(item({ updates: [{ at: iso(20), creatorId: MARK }, { at: iso(19), creatorId: SURAJ }] }), told(1, 19), now(23), RULES), { action: "none", reason: "he wrote last" });
}

console.log("Reminders");
{
  check("told Monday: not Tuesday", decideComplianceNudge(item(), told(1, 19), now(20), RULES).action, "none");
  check("told Monday: reminded Wednesday", decideComplianceNudge(item(), told(1, 19), now(21), RULES), { action: "remind", n: 2 });
  check("told Thursday: reminded Monday, not over the weekend", [
    decideComplianceNudge(item(), told(1, 22), now(23), RULES).action,
    decideComplianceNudge(item(), told(1, 22), now(24), RULES).action,
    decideComplianceNudge(item(), told(1, 22), now(26), RULES),
  ], ["none", "none", { action: "remind", n: 2 }]);
  check("we answered him on Tuesday: the two days count from then", [
    decideComplianceNudge(item({ updates: [{ at: iso(20, 12), creatorId: SURAJ }, { at: iso(20, 8), creatorId: MARK }] }), told(1, 19), now(21), RULES).action,
    decideComplianceNudge(item({ updates: [{ at: iso(20, 12), creatorId: SURAJ }, { at: iso(20, 8), creatorId: MARK }] }), told(1, 19), now(22), RULES),
  ], ["none", { action: "remind", n: 2 }]);
  check(`stops after ${MAX_MESSAGES} messages`, decideComplianceNudge(item(), told(MAX_MESSAGES, 5), now(19), RULES), { action: "none", reason: `told ${MAX_MESSAGES} times` });
}

console.log("The message");
{
  const a = { title: "Arbor 145 — W-9 tax form", url: "https://x.monday.com/boards/1/pulses/2", status: "Pending", createdAt: iso(19), ticketId: "14770" };
  const b = { title: "MNDA <draft> | v2", url: "https://x.monday.com/boards/1/pulses/3", status: null, createdAt: iso(5), ticketId: null };
  const board = "https://x.monday.com/boards/1";
  check("one new request", complianceNudgeText("Mark", [a], [], board),
    "Hi Mark, a new compliance request is on the monday board for you:\n• <https://x.monday.com/boards/1/pulses/2|Arbor 145 — W-9 tax form> (ticket #14770)\n\nCould you reply on the item, or here? Thanks.\n_Sent automatically from the Security Questionnaires board._");
  check("a reminder gives the status and the date, and cannot break the link", complianceNudgeText("Mark", [], [b], board).split("\n").slice(0, 2), [
    "Hi Mark, following up on this compliance request, still waiting on you on the monday board:",
    "• <https://x.monday.com/boards/1/pulses/3|MNDA draft v2>: no status, opened 5 Oct",
  ]);
  const both = complianceNudgeText("Mark", [a], [b], board);
  check("new and waiting share one message", [both.includes("a new compliance request is"), both.includes("Still waiting on you:"), (both.match(/Hi Mark/g) ?? []).length], [true, true, 1]);
  const many = complianceNudgeText("", [], Array.from({ length: MAX_LINES + 3 }, () => a), board);
  check("a long list is cut, with a count and the board link", [(many.match(/^• /gm) ?? []).length, many.includes(`…and 3 more on <${board}|the board>.`), many.startsWith("Hi there,")], [MAX_LINES, true, true]);
}

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\ncompliance-nudge: all passed");
