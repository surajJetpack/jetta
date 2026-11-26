/**
 * Does Jetta ask support only about a developer update the customer has really
 * not heard, a working day at a time, and stop after two asks? And is the
 * product manager brought in on a new feature request, once?
 *
 *   npx tsx scripts/dev-followup-support-test.ts
 *
 * The decisions only: no network, no storage.
 */
import { customerToldAbout } from "../lib/team-report-shared";
import { decidePmLoop, decideSupportNudge, pmLoopText, supportNudgeText, SUPPORT_MAX_ASKS, type NudgeState } from "../lib/dev-followup-support";
import { NUDGE_PHRASE } from "../lib/tools/monday";

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

const SAT = { weekend: [6] };
const WEEKEND = { weekend: [6, 0] };
// 2026-10-19 is a Monday.
const at = (d: number, h = 9) => Date.UTC(2026, 9, d, h);
const now = (d: number, h = 4) => new Date(Date.UTC(2026, 9, d, h, 30));
const update = (kind: "relay" | "ask" | "fixed" | "board", sinceAt: number, ticketId: number | null = 14752) => ({ kind, sinceAt, ticketId });
const asked = (n: number, d: number, extra: Partial<NudgeState> = {}): NudgeState => ({ n, at: now(d).toISOString(), ...extra });

console.log("A developer update nobody passed on");
{
  check("the run that first sees it asks: no waiting period", decideSupportNudge(update("relay", at(19, 9)), null, now(19, 9), SAT), { action: "ask", n: 1 });
  check("an update on Friday evening is asked about on Monday, not over the weekend", [
    decideSupportNudge(update("fixed", at(23, 22)), null, now(24), WEEKEND),
    decideSupportNudge(update("fixed", at(23, 22)), null, now(25), WEEKEND),
    decideSupportNudge(update("fixed", at(23, 22)), null, now(26), WEEKEND),
  ], [{ action: "none", reason: "day off" }, { action: "none", reason: "day off" }, { action: "ask", n: 1 }]);
  check("asked today: not again today", decideSupportNudge(update("relay", at(19)), asked(1, 20), now(20, 20), SAT), { action: "none", reason: "asked less than a working day ago" });
  check("asked late in the evening: not again just after midnight", decideSupportNudge(update("relay", at(19)), { n: 1, at: new Date(at(20, 23)).toISOString() }, now(21, 1), SAT).action, "none");
  check("asked on Friday: the reminder is Monday", [
    decideSupportNudge(update("relay", at(22)), asked(1, 23), now(25), WEEKEND).action,
    decideSupportNudge(update("relay", at(22)), asked(1, 23), now(26), WEEKEND),
  ], ["none", { action: "ask", n: 2 }]);
  check("a working day after the first ask: the second", decideSupportNudge(update("relay", at(19)), asked(1, 20), now(21), SAT), { action: "ask", n: 2 });
  check("a working day after the second: the escalation channel", decideSupportNudge(update("relay", at(19)), asked(SUPPORT_MAX_ASKS, 21), now(22), SAT), { action: "escalate" });
  check("escalated once, then nothing", decideSupportNudge(update("relay", at(19)), asked(2, 21, { escalated: true }), now(26), SAT), { action: "none", reason: "already escalated" });
  check("no ticket known: left to the unlinked follow-up", decideSupportNudge(update("board", at(10), null), null, now(20), SAT), { action: "none", reason: "no ticket" });
}

console.log("Was the customer already told?");
{
  const move = at(25, 6); // the developer's status change
  const H = 3_600_000;
  check("our reply after the move", customerToldAbout(move, move + H, "agent"), true);
  check("our reply 19 min before the move, nothing from the customer since (#14854)", customerToldAbout(move, move - 19 * 60_000, "agent"), true);
  check("our reply 42 min before Waiting Customer (#14868)", customerToldAbout(move, move - 42 * 60_000, "agent"), true);
  check("our reply the day before: not about this move", customerToldAbout(move, move - 20 * H, "agent"), false);
  check("the customer wrote last: not told", customerToldAbout(move, move + H, "customer"), false);
  check("no public message known: not told", customerToldAbout(move, null, "agent"), false);
}

console.log("What the ask says");
{
  const base = { sinceH: 26, ticketId: 14752, status: "Ready for review", draftReady: false };
  check("developers answered", supportNudgeText({ ...base, kind: "relay" }, 1), "The developers answered here 26h ago, and the customer on ticket #14752 has not been told yet. Could you pass it on?");
  check("developers need more", supportNudgeText({ ...base, kind: "ask", status: "Waiting Customer" }, 1), 'This was set to "Waiting Customer" 26h ago, and the customer on ticket #14752 has not been asked yet. Could you ask them for what the developers need?');
  check("fixed, with a draft waiting, second time", supportNudgeText({ ...base, kind: "fixed", status: "Done", draftReady: true }, 2), "Second reminder. This was finished 26h ago (Done), and ticket #14752 is still open with no reply to the customer since. Could you let them know? A draft reply from me is on the ticket.");
  // The developer follow-up counts posts carrying this phrase as asks to the DEVELOPER; an ask to support must not be one.
  check("never reads as an ask to the developer", ["relay", "ask", "fixed"].some((k) => supportNudgeText({ ...base, kind: k as "relay" }, 1).includes(NUDGE_PHRASE)), false);
}

console.log("Feature requests and the product manager");
{
  const NOW = now(30);
  const item = (over = {}) => ({ type: "Feature Request", group: "Client reported Field Issues", status: "ToDo", createdAt: at(27), reporter: "Sujata Shrestha", ...over });
  const open = { id: "14800", status: "open" };
  check("a new request with an open ticket: bring the PM in", decidePmLoop(item(), open, false, NOW), { action: "loop" });
  check("once only", decidePmLoop(item(), open, true, NOW), { action: "none", reason: "already brought in" });
  check("a bug is the developers' to answer", decidePmLoop(item({ type: "Bugs and Field Issues" }), open, false, NOW), { action: "none", reason: "not a feature request" });
  check("an old request is backlog, not news", decidePmLoop(item({ createdAt: at(1) }), open, false, NOW), { action: "none", reason: "older than two weeks" });
  check("the ticket is resolved: nobody is waiting", decidePmLoop(item(), { id: "1", status: "resolved" }, false, NOW).action, "none");
  check("a finished item", decidePmLoop(item({ group: "Done", status: "Done" }), open, false, NOW), { action: "none", reason: "item finished" });
  check("no ticket, but support filed it", decidePmLoop(item(), null, false, NOW), { action: "loop" });
  check("no ticket and no Reporter: the team's own idea", decidePmLoop(item({ reporter: null }), null, false, NOW), { action: "none", reason: "no ticket and no Reporter" });
  check("the comment, with a ticket", pmLoopText("Binod", "14800", "Sujata Shrestha"), "Bringing Binod in as product manager: this feature request came from a customer (ticket #14800). Is it something we plan to do, and what should support tell the customer in the meantime?");
  check("the comment, without one", pmLoopText("Binod", null, "Sujata Shrestha").includes("came from a customer, filed by Sujata Shrestha."), true);
}

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\ndev-followup-support-test: all passed");
