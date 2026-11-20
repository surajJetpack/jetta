/**
 * Deterministic tests for the daily team report (lib/team-report.ts).
 *   npx tsx scripts/team-report-test.ts
 *
 * No network, no storage: synthetic activities and ticket records.
 */
import { parseAliases, type Activity } from "../lib/activity";
import type { PerfTicket } from "../lib/performance";
import { buildTeamReport, fmtHours, formatTeamReport, isEmptyReport } from "../lib/team-report";

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`}`);
}

const TZ = "Asia/Kathmandu"; // UTC+5:45: 2026-11-19 runs 18:15Z on the 18th to 18:15Z on the 19th.
const DAY = "2026-11-19";
const at = (iso: string) => Date.parse(iso);
let seq = 0;
const act = (over: Partial<Activity> & Pick<Activity, "at" | "who" | "action" | "place">): Activity => ({ id: `a${++seq}`, ...over });

const ticket = (over: Partial<PerfTicket> & Pick<PerfTicket, "id" | "createdAt">): PerfTicket => ({
  subject: `Ticket ${over.id}`,
  status: 2,
  updatedAt: over.createdAt,
  source: 1,
  agentReplies: 0,
  customerMsgs: 1,
  firstReplyH: null,
  firstReplyBy: null,
  firstReplyWords: null,
  firstReplyHasLink: false,
  resolvedH: null,
  reopened: false,
  suggestions: [],
  fromChat: false,
  devWork: false,
  ...over,
});

const aliases = parseAliases("Cherryl=Solutions Team");

const acts: Activity[] = [
  // Cherryl, under two Freshdesk names and the console: one person.
  act({ at: at("2026-11-19T02:56:00Z"), who: "Cherryl Bensolan", action: "fd.reply", place: "freshdesk", ticketId: "14809" }),
  act({ at: at("2026-11-19T02:59:00Z"), who: "Cherryl Bensolan", action: "fd.reply", place: "freshdesk", ticketId: "14809" }),
  act({ at: at("2026-11-19T17:55:00Z"), who: "Solutions Team", action: "fd.reply", place: "freshdesk", ticketId: "14815" }),
  act({ at: at("2026-11-19T17:56:00Z"), who: "Solutions Team", action: "fd.note", place: "freshdesk", ticketId: "14815" }),
  act({ at: at("2026-11-19T17:57:00Z"), who: "console:cherryl", action: "fd.draft_used", place: "freshdesk", ticketId: "14815" }),
  act({ at: at("2026-11-19T06:00:00Z"), who: "console:cherryl", action: "console.kb", place: "console" }),
  act({ at: at("2026-11-19T07:00:00Z"), who: "Cherryl", action: "chat.joined", place: "chat", waitMs: 4 * 60_000 }),
  // Sujata on the dev boards and in Slack.
  act({ at: at("2026-11-19T05:00:00Z"), who: "Sujata Shrestha", action: "monday.comment", place: "monday", ref: "111" }),
  act({ at: at("2026-11-19T05:01:00Z"), who: "Sujata Shrestha", action: "monday.status", place: "monday", ref: "111" }),
  act({ at: at("2026-11-19T05:02:00Z"), who: "Sujata Shrestha", action: "monday.created", place: "monday", ref: "222" }),
  act({ at: at("2026-11-19T05:03:00Z"), who: "Sujata Shrestha", action: "slack.reply", place: "slack", waitMs: 30 * 60_000 }),
  // Outside the support day on both sides: 18:20Z on the 19th is already the 20th in Kathmandu.
  act({ at: at("2026-11-19T18:20:00Z"), who: "Sujata Shrestha", action: "fd.reply", place: "freshdesk", ticketId: "1" }),
  act({ at: at("2026-11-18T18:00:00Z"), who: "Sujata Shrestha", action: "fd.reply", place: "freshdesk", ticketId: "2" }),
  // A sign-in is not work, and a person with only that is not listed.
  act({ at: at("2026-11-19T04:00:00Z"), who: "console:nir", action: "console.login", place: "console" }),
];

const tickets: PerfTicket[] = [
  // Came in and was answered that day by Cherryl, after Jetta's draft, sent as-is.
  ticket({
    id: 14815,
    createdAt: "2026-11-19T16:34:00Z",
    status: 6,
    agentReplies: 1,
    firstReplyH: 1.35,
    firstReplyBy: "Solutions Team",
    lastPublicFrom: "agent",
    lastPublicAt: "2026-11-19T17:55:00Z",
    suggestions: [{ at: "2026-11-19T16:35:00Z", sim: 0.99, replyBy: "Solutions Team", waitH: 1.33 }],
    handoff: { kinds: ["dev_item"], at: "2026-11-19T16:35:30Z", itemIds: [] } as PerfTicket["handoff"],
  }),
  // Came in that day, answered from the shared login within minutes.
  ticket({ id: 14820, createdAt: "2026-11-19T10:00:00Z", status: 6, agentReplies: 1, firstReplyH: 0.1, firstReplyBy: "App Support", lastPublicFrom: "agent" }),
  // Came in that day, nobody has answered: owed since it was created.
  ticket({ id: 14821, createdAt: "2026-11-19T12:00:00Z", subject: "Board <limit> & error", lastPublicFrom: "customer" }),
  // Older ticket where the customer wrote last, two days before the report.
  ticket({ id: 14700, createdAt: "2026-11-01T00:00:00Z", agentReplies: 2, firstReplyH: 3, firstReplyBy: "Sujata Shrestha", lastPublicFrom: "customer", lastPublicAt: "2026-11-18T04:00:00Z" }),
  // Closed: owes nothing whatever the thread says.
  ticket({ id: 14600, createdAt: "2026-10-20T00:00:00Z", status: 5, lastPublicFrom: "customer" }),
  // Junk never counts, as a new ticket or as owed.
  ticket({ id: 14822, createdAt: "2026-11-19T11:00:00Z", subject: "Automatic reply: out of office" }),
  // Closed the same day with no reply from anyone: a booking confirmation, not a new ticket.
  ticket({ id: 14823, createdAt: "2026-11-19T13:00:00Z", subject: "Appointment booked: Solution consulting", status: 5 }),
  // A draft written that day that nobody has sent yet.
  ticket({ id: 14789, createdAt: "2026-11-17T00:43:00Z", status: 6, agentReplies: 1, lastPublicFrom: "agent", suggestions: [{ at: "2026-11-19T10:04:00Z", sim: null, replyBy: null, waitH: null }] }),
];

const now = at("2026-11-20T04:00:00Z");
const r = buildTeamReport({ day: DAY, tz: TZ, acts, tickets, aliases, now });

check("people are alphabetical, sign-in-only people are left out", r.people.map((p) => p.name), ["Cherryl", "Sujata"]);
const [cherryl, sujata] = r.people;
check("Freshdesk names and the console merge into one person", cherryl.fd, { replies: 3, notes: 1, tickets: 2, firstReplies: 1, firstReplyH: 1.35 });
check("draft outcomes are not console work, and are not reported per person", [cherryl.console, "drafts" in cherryl], [1, false]);
check("chat pickup time", cherryl.chat, { taken: 1, actions: 0, pickupMin: 4 });
check("monday actions and distinct items", sujata.monday, { created: 1, comments: 1, status: 1, moved: 0, items: 2 });
check("activity outside the support day is not counted", sujata.fd.replies, 0);
check("slack response time", sujata.slack, { messages: 1, responseMin: 30 });

check("team: new tickets, junk and closed-unanswered mail excluded", [r.team.newTickets, r.team.answered], [3, 2]);
check("team: median first reply of that day's answered tickets", r.team.firstReplyH, 0.73);
check("team: owed now, oldest first, closed and junk excluded", r.team.oldestOwed.map((o) => [o.id, Math.round(o.sinceH)]), [
  [14700, 48],
  [14821, 16],
]);
check("first replies from a login with no person behind it", r.team.sharedFirstReplies, [{ login: "App Support", count: 1, firstReplyH: 0.1 }]);
check("jetta: drafts, what followed, handoffs", r.jetta, { drafts: 2, followed: { asIs: 1, edited: 0, rewritten: 0 }, handoffs: { dev_item: 1, slack: 0, chat: 0 } });

const text = formatTeamReport(r, { ticketUrlBase: "https://x.freshdesk.com/a/tickets/", consoleUrl: "https://console.example" });
console.log(`\n${text}\n`);
check("text: header names the day and zone", text.split("\n")[0], ":bar_chart: *Support team, Thu 19 Nov* _(Asia/Kathmandu day)_");
check("text: team line", text.includes("*Team:* 3 new tickets, 2 answered (median first reply 44 min) · 2 customers waiting on a reply right now"), true);
check("text: owed tickets link and escape customer text", text.includes("• <https://x.freshdesk.com/a/tickets/14821|#14821> Board &lt;limit&gt; &amp; error: waiting 16h"), true);
check("text: a person's Freshdesk line", text.includes("• Freshdesk: 3 replies, 1 note on 2 tickets · 1 first reply (median 1.4h after the ticket came in)"), true);
check("text: monday line", text.includes("• monday dev boards: 1 item created, 1 comment, 1 status change across 2 items"), true);
check("text: jetta block", text.includes("• 2 drafts written · of 1 reply sent after a draft: 1 as-is, 0 edited, 0 replaced"), true);
check("text: no per-person line about Jetta's drafts", text.includes("Jetta's drafts:"), false);
check("text: no ranking words", /\b(top|rank|best|worst|leader)/i.test(text), false);

check("fmtHours", [fmtHours(0.1), fmtHours(5.25), fmtHours(80), fmtHours(5587)], ["6 min", "5.3h", "3.3d", "233d"]);

// Support health's backlog knows each ticket's current status; when it is there it wins.
const withHealth = buildTeamReport({
  day: DAY,
  tz: TZ,
  acts,
  tickets,
  aliases,
  now,
  backlog: { owesReply: 5, waiting: [{ ticketId: 9, subject: "Short wait", waitingH: 2 }, { ticketId: 8, subject: "Long wait", waitingH: 30 }] },
});
check("team: Support health's backlog replaces the record-based one", [withHealth.team.owed, withHealth.team.oldestOwed.map((o) => o.id)], [5, [8, 9]]);

const quiet = buildTeamReport({ day: "2026-11-21", tz: TZ, acts, tickets: tickets.filter((t) => t.status === 5), aliases, now });
check("a day with nothing is empty, and says so if printed", [isEmptyReport(quiet), formatTeamReport(quiet).includes("Nothing recorded")], [true, true]);
check("a day with work is not empty", isEmptyReport(r), false);

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
