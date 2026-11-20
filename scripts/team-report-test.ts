/**
 * Deterministic tests for the daily team report (lib/team-report.ts).
 *   npx tsx scripts/team-report-test.ts
 *
 * No network, no storage: synthetic activities and ticket records.
 */
import { parseAliases, type Activity } from "../lib/activity";
import type { DevRow } from "../lib/dev-board";
import type { PerfTicket } from "../lib/performance";
import { buildTeamReport, fmtHours, formatTeamReport, isEmptyReport, TABLE_CHAR_BUDGET, teamReportMessages, type TableBlock } from "../lib/team-report";

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
check("Freshdesk names and the console merge into one person", cherryl.fd, { replies: 3, notes: 1, tickets: 2, ticketIds: [14809, 14815], firstReplies: 1, firstReplyH: 1.35 });
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
check("jetta: drafts, what followed, handoffs", r.jetta, {
  drafts: 2,
  followed: { asIs: 1, edited: 0, rewritten: 0 },
  handoffs: { dev_item: 1, slack: 0, chat: 0 },
  firstReplies: 0,
  firstReplyH: null,
  devItemsFiled: null,
  replies: { first: 0, followups: 0, ticketIds: [] },
});

const text = formatTeamReport(r, { ticketUrlBase: "https://x.freshdesk.com/a/tickets/", consoleUrl: "https://console.example" });
console.log(`\n${text}\n`);
check(
  "text: one header line with the team's numbers, waiting linked to Support health",
  text.split("\n")[0],
  ":bar_chart: *Support, Thu 19 Nov* · 3 new, 2 answered (first reply 44 min) · <https://console.example/health|2 waiting on us> · 1 first reply from the App Support login",
);
check("text: every line is short", text.split("\n").every((l) => l.length < 420), true);
check(
  "actions: waiting past the same-shift bar, with who answered last",
  r.actions.reply.map((a) => [a.id, a.lastBy, a.draftReady]),
  [
    [14700, "Sujata", false],
    [14821, null, false],
  ],
);
check("text: replies owed are one line of ticket links", text.includes("• *Reply:* <https://x.freshdesk.com/a/tickets/14700|#14700> 2d · <https://x.freshdesk.com/a/tickets/14821|#14821> 16h"), true);
check("text: no ticket subjects (customer text) in the post", text.includes("limit"), false);
check(
  "text: a person is one line, their tickets linked",
  text.includes("• *Cherryl:* 3 replies, 1 note (<https://x.freshdesk.com/a/tickets/14809|#14809> <https://x.freshdesk.com/a/tickets/14815|#14815>), 1 first reply in 1.4h · 1 chat taken in 4 min · console: 1"),
  true,
);
check("text: dev board and Slack on a person's line", text.includes("• *Sujata:* dev board: 1 filed, 1 comment, 1 status change · Slack: 1 (answers in 30 min)"), true);
check("text: jetta's line", text.includes("• *Jetta:* 2 drafts (of 1 sent after one: 1 as-is, 0 edited, 0 replaced) · dev board: 1 filed"), true);
check("text: without a roster everyone is in the second group, alphabetical, Jetta among them", [...text.matchAll(/^(?:\*([A-Z][a-z ]+)\*|• \*([A-Z][a-z]+):\*)/gm)].map((m) => m[1] ?? m[2]).slice(-4), ["Developers and others", "Cherryl", "Jetta", "Sujata"]);

// With her login aliased, her own first replies move from the team line into her block.
const named = buildTeamReport({
  day: DAY,
  tz: TZ,
  acts,
  tickets,
  aliases: parseAliases("Cherryl=Solutions Team;Jetta=App Support"),
  now,
  devRows: [],
});
check("jetta: first replies under her own name once the login has an alias", [named.jetta.firstReplies, named.jetta.firstReplyH, named.team.sharedFirstReplies, named.jetta.devItemsFiled], [1, 0.1, [], 0]);
check("text: jetta's first replies", formatTeamReport(named).includes("• *Jetta:* 1 first reply in 6 min · 2 drafts"), true);
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

// Action items: a short wait is not one, a long one is "reply or close", a pending draft is mentioned.
const acting = buildTeamReport({
  day: DAY,
  tz: TZ,
  acts,
  tickets,
  aliases,
  now,
  backlog: {
    owesReply: 4,
    waiting: [
      { ticketId: 9, subject: "Just came in", waitingH: 2 },
      { ticketId: 14789, subject: "Address in subject line", waitingH: 7 },
      { ticketId: 8, subject: "Forgotten", waitingH: 20 * 24 },
      { ticketId: 7, subject: "Overnight", waitingH: 13 },
    ],
  },
});
check("actions: under the bar is left out, stale is its own list", [acting.actions.reply.map((a) => a.id), acting.actions.stale.map((a) => a.id)], [[7, 14789], [8]]);
check("actions: a draft nobody has sent is flagged", acting.actions.reply.find((a) => a.id === 14789)?.draftReady, true);
const actingText = formatTeamReport(acting);
check("text: a waiting draft is marked, with a legend", [actingText.includes("• *Reply:* #7 13h · #14789 7h :memo:"), actingText.includes("_:memo: Jetta's draft is on the ticket_")], [true, true]);
check("text: stale tickets are one line", actingText.includes("• *Reply or close* (14d+): #8 20d"), true);
const calm = buildTeamReport({ day: DAY, tz: TZ, acts, tickets, aliases, now, backlog: { owesReply: 1, waiting: [{ ticketId: 9, subject: "Just came in", waitingH: 2 }] } });
check("text: no action section when nothing needs doing", formatTeamReport(calm).includes("To do"), false);

// Replies Jetta sent herself, from her send events: counted for that day only, tickets linked.
const sending = buildTeamReport({
  day: DAY,
  tz: TZ,
  acts,
  tickets,
  aliases: parseAliases("Jetta=App Support"),
  now,
  jettaSent: [
    { at: at("2026-11-19T10:06:00Z"), ticketId: 14820, kind: "first" },
    { at: at("2026-11-19T15:00:00Z"), ticketId: 14700, kind: "followup" },
    { at: at("2026-11-19T16:00:00Z"), ticketId: 14700, kind: "followup" },
    { at: at("2026-11-19T19:00:00Z"), ticketId: 14999, kind: "followup" }, // the 20th in Kathmandu
  ],
});
check("jetta: her own sends that day", sending.jetta.replies, { first: 1, followups: 2, ticketIds: [14700, 14820] });
check(
  "text: jetta's replies, linked",
  formatTeamReport(sending, { ticketUrlBase: "https://x.freshdesk.com/a/tickets/" }).includes(
    "• *Jetta:* 3 replies sent (<https://x.freshdesk.com/a/tickets/14700|#14700> <https://x.freshdesk.com/a/tickets/14820|#14820>): 1 first response in 6 min, 2 follow-ups · 2 drafts",
  ),
  true,
);

// Developer updates the customer has not heard about.
const H = 3_600_000;
const row = (over: Partial<DevRow> & Pick<DevRow, "id">): DevRow => ({
  board: "getsign",
  app: "GetSign",
  name: `Item ${over.id}`,
  url: `https://monday.example/${over.id}`,
  group: "Working on it",
  status: "Working on it",
  origin: "support",
  filedBy: "Sujata Shrestha",
  developers: [],
  support: ["Sujata Shrestha"],
  createdAt: now - 100 * H,
  resolvedAt: null,
  firstEngAt: null,
  move: null,
  waitingSince: null,
  lastActionAt: now - H,
  nudgeAts: [],
  bounceAts: [],
  customerWaits: 0,
  gaps: [],
  posts: 3,
  kind: null,
  area: null,
  rootCause: null,
  lesson: null,
  kbTitle: null,
  kbWorthy: false,
  kb: null as DevRow["kb"],
  kbDraftId: null,
  friction: [],
  ...over,
});
const devTickets: PerfTicket[] = [
  // We wrote last, 10h ago: before the developers answered 5h ago, after the fix 20h ago.
  ticket({ id: 500, createdAt: "2026-11-15T00:00:00Z", status: 8, agentReplies: 1, lastPublicFrom: "agent", lastPublicAt: new Date(now - 10 * H).toISOString() }),
  ticket({ id: 501, createdAt: "2026-11-15T00:00:00Z", status: 8, agentReplies: 1, lastPublicFrom: "agent", lastPublicAt: new Date(now - 10 * H).toISOString() }),
  ticket({ id: 502, createdAt: "2026-11-15T00:00:00Z", status: 8, agentReplies: 1, lastPublicFrom: "agent", lastPublicAt: new Date(now - 30 * H).toISOString(), handoff: { kinds: ["dev_item"], at: "2026-11-15T01:00:00Z", itemIds: ["i-fixed"] } }),
  ticket({ id: 503, createdAt: "2026-11-15T00:00:00Z", status: 5, agentReplies: 1, lastPublicFrom: "agent", lastPublicAt: new Date(now - 30 * H).toISOString() }),
  ticket({ id: 504, createdAt: "2026-11-15T00:00:00Z", status: 8, agentReplies: 1, lastPublicFrom: "agent", lastPublicAt: new Date(now - 30 * H).toISOString() }),
];
const devRows: DevRow[] = [
  row({ id: "i-relay", name: "Email not extracted <Person>", move: "support", waitingSince: now - 5 * H, status: "Ready for Review" }),
  row({ id: "i-told", move: "support", waitingSince: now - 20 * H }), // ticket 501: we wrote to the customer since
  row({ id: "i-fixed", move: null, resolvedAt: now - 20 * H, status: "Deployed to Prod" }), // linked through the handoff note
  row({ id: "i-closed", move: "support", waitingSince: now - 5 * H }), // its ticket is closed
  row({ id: "i-ask", move: "customer", waitingSince: now - 3 * H, status: "Waiting Customer" }),
  row({ id: "i-board", move: "support", waitingSince: now - 2 * H }), // no ticket known
  row({ id: "i-old", move: "support", waitingSince: now - 20 * 24 * H }), // no ticket, handed back long ago
  row({ id: "i-eng", move: "engineering", waitingSince: now - 2 * H }), // engineering's move: nothing to relay
  row({ id: "i-roadmap", origin: "internal", move: "support", waitingSince: now - 2 * H }), // not a client issue
];
const links = new Map([
  ["i-relay", "500"],
  ["i-told", "501"],
  ["i-closed", "503"],
  ["i-ask", "504"],
]);
const withDev = buildTeamReport({ day: DAY, tz: TZ, acts, tickets: devTickets, aliases, now, backlog: { owesReply: 0, waiting: [] }, devRows, itemTickets: links });
check(
  "dev actions: only updates the customer has not heard about, newest first",
  withDev.actions.dev.map((a) => [a.itemId, a.kind, a.ticketId, Math.round(a.sinceH)]),
  [
    ["i-board", "board", null, 2],
    ["i-ask", "ask", 504, 3],
    ["i-relay", "relay", 500, 5],
    ["i-fixed", "fixed", 502, 20],
  ],
);
check("dev actions: an old handback is counted, not listed", withDev.actions.devOlder, 1);
const devText = formatTeamReport(withDev, { ticketUrlBase: "https://x.freshdesk.com/a/tickets/", consoleUrl: "https://console.example" });
check(
  "text: a developer update links the ticket and the dev item",
  devText.includes("• *Relay dev update:* <https://x.freshdesk.com/a/tickets/500|#500> (<https://monday.example/i-relay|dev item>)"),
  true,
);
check("text: the other dev kinds", [devText.includes("• *Fixed, tell customer:* <https://x.freshdesk.com/a/tickets/502|#502> (<https://monday.example/i-fixed|dev item>)"), devText.includes("• *Dev needs customer info:* <https://x.freshdesk.com/a/tickets/504|#504> (<https://monday.example/i-ask|dev item>)"), devText.includes("• *Handed back on dev board:* <https://monday.example/i-board|dev item>")], [true, true, true]);
check("text: older handbacks are one linked line", devText.includes("• <https://console.example/dev-board|1 dev item handed back 14d+ ago>"), true);
check("text: dev updates alone are enough for a To do section", devText.includes("*To do*"), true);

// The same report as Slack tables: a To do table and a Team table, one per message.
const L = { ticketUrlBase: "https://x.freshdesk.com/a/tickets/", consoleUrl: "https://console.example" };
/** A cell as text, links shown as [text]. */
const flat = (c: TableBlock["rows"][number][number]) =>
  c.elements[0].elements.map((e) => (e.type === "link" ? `[${e.text}]` : e.type === "emoji" ? `:${e.name}:` : e.text)).join("");
const tableOf = (m: { blocks: unknown[] }) => (m.blocks as TableBlock[]).find((b) => b.type === "table");
// A support roster splits the table in two; every count is a link to its list on Team activity.
const grouped = buildTeamReport({
  day: DAY,
  tz: TZ,
  acts,
  tickets,
  aliases: parseAliases("Cherryl=Solutions Team;Jetta=App Support"),
  now,
  support: ["Cherryl", "Gabriel"],
  jettaSent: [{ at: at("2026-11-19T10:06:00Z"), ticketId: 14820, kind: "first" }],
});
check("groups: the support roster, everyone else", grouped.people.map((p) => [p.name, p.group]), [
  ["Cherryl", "support"],
  ["Sujata", "other"],
]);
const msgs = teamReportMessages(grouped, L)!;
check("tables: two messages, the summary line first", [msgs.length, msgs[0].text.startsWith(":bar_chart: *Support, Thu 19 Nov*")], [2, true]);
check("tables: To do rows", tableOf(msgs[0])!.rows.map((row) => row.map(flat)), [
  ["To do", "Tickets"],
  ["Reply", "[#14700] 2d  [#14821] 16h"],
]);
const teamTable = tableOf(msgs[1])!;
check("tables: Team is grouped, four columns, counts as links", teamTable.rows.map((row) => row.map(flat)), [
  ["Name", "Freshdesk", "monday dev boards", "Other"],
  ["SUPPORT", " ", " ", " "],
  ["Cherryl", "[3 replies] · [1 note] · 1 first reply (1.4h)", "–", "[1 chat taken] (in 4 min) · 1 console decision"],
  ["DEVELOPERS AND OTHERS", " ", " ", " "],
  ["Jetta", "1 reply sent ([#14820]) · [2 drafts written]", "[1 item filed]", "–"],
  ["Sujata", "–", "[1 item filed] · [1 comment] · [1 status change]", "[1 Slack message]"],
]);
const linkIn = (row: number, col: number, label: string) => teamTable.rows[row][col].elements[0].elements.find((e) => e.type === "link" && e.text === label);
check("tables: a count opens that person's list of that action for that day", linkIn(2, 1, "3 replies"), {
  type: "link",
  url: "https://console.example/activity?person=cherryl&action=fd.reply&day=2026-11-19&tz=Asia%2FKathmandu",
  text: "3 replies",
});
check("tables: comments open the comments", (linkIn(5, 2, "1 comment") as { url: string }).url, "https://console.example/activity?person=sujata&action=monday.comment&day=2026-11-19&tz=Asia%2FKathmandu");
check("tables: Jetta's reply links the ticket itself", linkIn(4, 1, "#14820"), { type: "link", url: "https://x.freshdesk.com/a/tickets/14820", text: "#14820" });

const devMsgs = teamReportMessages(withDev, L)!;
check("tables: developer updates link the ticket and the dev item", tableOf(devMsgs[0])!.rows.map((row) => row.map(flat)).slice(1), [
  ["Relay dev update", "[#500] ([dev item])"],
  ["Dev needs customer info", "[#504] ([dev item])"],
  ["Fixed, tell customer", "[#502] ([dev item])"],
  ["Handed back on dev board", "[dev item]"],
  ["Older on dev board", "[1 dev item handed back 14d+ ago]"],
]);
check("tables: nothing to do means no To do table", tableOf(teamReportMessages(calm, L)![0]), undefined);
// Too big for Slack's table limit: no tables, so the caller posts text.
const huge = { ...grouped, people: Array.from({ length: 80 }, (_, i) => ({ ...grouped.people[0], name: `Person${i}`, key: `p${i}` })) };
check("tables: over the size budget returns null", [TABLE_CHAR_BUDGET, teamReportMessages(huge, L)], [9000, null]);

const quiet = buildTeamReport({ day: "2026-11-21", tz: TZ, acts, tickets: tickets.filter((t) => t.status === 5), aliases, now });
check("a day with nothing is empty, and prints only the header", [isEmptyReport(quiet), formatTeamReport(quiet).split("\n").length], [true, 1]);
check("a day with work is not empty", isEmptyReport(r), false);

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
