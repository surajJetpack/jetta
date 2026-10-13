/**
 * Deterministic tests for the /dev-board numbers (lib/dev-board.ts).
 *   npx tsx scripts/dev-board-test.ts [board-dump.json]
 *
 * No network, no storage — synthetic items modelled on real threads. Given a
 * dump from scripts/dev-board-dump.ts, it also checks every headline number on
 * real data adds up to the list its drill opens.
 */
import { readFileSync } from "node:fs";
import {
  asksSupport,
  buildSummary,
  canonicalNames,
  devRow,
  drillRows,
  itemOrigin,
  parseSupport,
  resolvedAt,
  type DevItem,
  type DevPost,
  type Roster,
  type StatusChange,
} from "../lib/dev-board";

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n     expected ${JSON.stringify(expected)}\n     got      ${JSON.stringify(actual)}`}`);
}

const H = 3_600_000;
const D = 24 * H;
const NOW = Date.parse("2026-10-13T00:00:00Z");
const roster: Roster = { support: parseSupport("Cherryl, Sujata Shrestha,Gabriel"), self: "Suraj Malla" };
const names = canonicalNames(["Cherryl B", "Cherryl B", "Cherryl", "Prashant Uprety", "Prashant Uprety", "Prashant test account"]);

let n = 0;
const post = (at: number, who: string, text: string): DevPost => ({ id: String(++n), at, who, text });
const change = (at: number, to: string, by: string, kind: "status" | "group" = "status"): StatusChange => ({ at, kind, to, by });
function item(p: Partial<DevItem>): DevItem {
  return {
    id: String(++n),
    board: "jetpackapps",
    boardId: "1",
    name: "Item",
    url: "",
    group: "Bugs and Field Issues",
    status: "Ready to start",
    developers: ["Prashant Uprety"],
    reviewers: [],
    reporter: null,
    priority: null,
    type: null,
    project: "TrackMy",
    createdAt: NOW - 10 * D,
    updatedAt: NOW - D,
    creator: "Cherryl B",
    posts: [],
    changes: [],
    ...p,
  };
}

// ── Names and roles ──
check("most frequent spelling wins over longest", names.get("Prashant test account"), "Prashant Uprety");
check("Cherryl and Cherryl B merge", names.get("Cherryl"), "Cherryl B");
check("a question passes the move", asksSupport("Can you ask for the board link?", roster), true);
check("an @mention of support passes the move", asksSupport("@Cherryl B Done pls ask customer to check once", roster), true);
check("a progress note keeps it", asksSupport("looks like they replied to me. I will look at this today", roster), false);
check("@mentioning another developer keeps it", asksSupport("@Prabesh Uprety take this over", roster), false);

// ── Origin ──
const jettaFiled = item({ creator: "Suraj Malla", posts: [post(NOW - 10 * D, "Suraj Malla", "Product: getsign Account: x Freshdesk ticket: y")] });
check("Jetta's context post makes it Jetta's", itemOrigin(jettaFiled, roster), "jetta");
check("Suraj's own item is not Jetta's", itemOrigin(item({ creator: "Suraj Malla", posts: [post(NOW, "Suraj Malla", "Please fix the logo")] }), roster), "internal");
check("support creator → support", itemOrigin(item({}), roster), "support");
check("support reporter → support", itemOrigin(item({ creator: "Niro", reporter: "Gabriel Villegas, Niro" }), roster), "support");
check("lead's roadmap item → internal", itemOrigin(item({ creator: "Niro", reporter: "Niro" }), roster), "internal");

// ── Resolution time ──
check(
  "resolved at the first finish after the LAST reopening",
  resolvedAt(item({
    status: "Done",
    changes: [change(NOW - 8 * D, "Done", "Prashant Uprety"), change(NOW - 6 * D, "Testing Failed", "Cherryl B"), change(NOW - 4 * D, "Done", "Prashant Uprety"), change(NOW - 3 * D, "Done", "x", "group")],
  })),
  NOW - 4 * D,
);
check("moved to the Done group counts", resolvedAt(item({ group: "Done", status: "Ready for review", changes: [change(NOW - 2 * D, "Done", "Cherryl B", "group")] })), NOW - 2 * D);
check("open → null", resolvedAt(item({ status: "Working on it", changes: [change(NOW - 2 * D, "Done", "x")] })), null);
check("finished before the log reaches → null", resolvedAt(item({ status: "Done", changes: [] })), null);

// ── Whose move ──
const engMove = devRow(item({ posts: [post(NOW - 10 * D, "Cherryl B", "Customer says sync stopped")] }), roster, names, null);
check("support spoke last → engineering's move", [engMove.move, engMove.waitingSince], ["engineering", NOW - 10 * D]);
check("no engineering reply yet → no first response", engMove.firstEngAt, null);

const progress = devRow(item({
  posts: [post(NOW - 9 * D, "Cherryl B", "Any update?"), post(NOW - D, "Prashant Uprety", "I will look at this today")],
}), roster, names, null);
check("a progress note keeps engineering's move", progress.move, "engineering");
// The note answers the ask: the wait runs from engineering's last word, not from the 9-day-old question.
check("…and the wait runs from the progress note", progress.waitingSince, NOW - D);
check("nudge counted", progress.nudgeAts.length, 1);
check("first engineering response", progress.firstEngAt, NOW - D);

const handedBack = devRow(item({
  posts: [post(NOW - 9 * D, "Cherryl B", "Broken")],
  changes: [change(NOW - 2 * D, "Ready for review", "Prashant Uprety")],
}), roster, names, null);
check("Ready for review hands it to support", [handedBack.move, handedBack.waitingSince], ["support", NOW - 2 * D]);

const ownQueue = devRow(item({
  posts: [post(NOW - 9 * D, "Cherryl B", "Broken")],
  changes: [change(NOW - 2 * D, "Working on it", "Prashant Uprety")],
}), roster, names, null);
check("engineering's own queue status keeps the move", ownQueue.move, "engineering");
check("…and counts as the first response", ownQueue.firstEngAt, NOW - 2 * D);

const customer = devRow(item({ status: "Waiting Customer", changes: [change(NOW - 3 * D, "Waiting Customer", "Cherryl B")] }), roster, names, null);
check("Waiting Customer → customer's move", [customer.move, customer.waitingSince], ["customer", NOW - 3 * D]);

const gaps = devRow(item({
  posts: [post(NOW - 9 * D, "Cherryl B", "Broken"), post(NOW - 8 * D, "Cherryl", "Still broken"), post(NOW - 7 * D, "Prashant Uprety", "Which board?"), post(NOW - 7 * D + 2 * H, "Cherryl B", "Board 123")],
}), roster, names, null);
check(
  "reply gaps run from the FIRST unanswered post, attributed to the answerer",
  gaps.gaps.map((g) => [g.who, g.role, (g.at - g.from) / H]),
  [["Prashant Uprety", "engineering", 48], ["Cherryl B", "support", 2]],
);

// ── Summary vs drills on synthetic data ──
const synth = [engMove, progress, handedBack, ownQueue, customer, gaps];
const s = buildSummary(synth, { now: NOW, minedPending: 0, boards: {} });
check("open = the three moves", s.now.open, s.now.engineering + s.now.support + s.now.customer);
check("open drill adds up", drillRows(synth, { kind: "open" }, NOW).length, s.now.open);

// ── Optional: real dump ──
const dump = process.argv[2];
if (dump) {
  const d = JSON.parse(readFileSync(dump, "utf8")) as { self: string; at: number; items: DevItem[] };
  const r: Roster = { support: parseSupport("Cherryl,Sujata,Gabriel"), self: d.self };
  const nm = canonicalNames(d.items.flatMap((i) => [i.creator, ...i.developers, ...i.posts.map((p) => p.who), ...i.changes.map((c) => c.by)].filter((x): x is string => !!x)));
  const rows = d.items.map((i) => devRow(i, r, nm, null));
  const sum = buildSummary(rows, { now: d.at, minedPending: 0, boards: {} });
  console.log(`\nreal dump: ${rows.length} items`);
  check("filed", drillRows(rows, { kind: "filed" }, d.at).length, sum.recent.filed);
  check("resolved", drillRows(rows, { kind: "resolved" }, d.at).length, sum.recent.resolved);
  check("bounced", drillRows(rows, { kind: "bounced" }, d.at).length, sum.recent.bounced);
  check("open", drillRows(rows, { kind: "open" }, d.at).length, sum.now.open);
  check("stale", drillRows(rows, { kind: "open", stale: true }, d.at).length, sum.now.stale);
  check("dormant", drillRows(rows, { kind: "dormant" }, d.at).length, sum.now.dormant);
  for (const m of ["engineering", "support", "customer"] as const) {
    check(`move ${m}`, drillRows(rows, { kind: "open", move: m }, d.at).length, sum.now[m]);
  }
  for (const dev of sum.developers) {
    check(`dev ${dev.name} open`, drillRows(rows, { kind: "dev", person: dev.name, metric: "open" }, d.at).length, dev.open);
    check(`dev ${dev.name} resolved`, drillRows(rows, { kind: "dev", person: dev.name, metric: "resolved" }, d.at).length, dev.resolved);
  }
  for (const sp of sum.supportTeam) {
    check(`support ${sp.name} filed`, drillRows(rows, { kind: "support", person: sp.name, metric: "filed" }, d.at).length, sp.filed);
    check(`support ${sp.name} on their move`, drillRows(rows, { kind: "support", person: sp.name, metric: "yourMove" }, d.at).length, sp.yourMove);
  }
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
