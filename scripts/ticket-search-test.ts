/**
 * Tests for date-windowed ticket search — the intake question ("what came in on
 * Saturday") that Jetta had no route to before.
 *
 *   npx tsx --env-file=.env.local scripts/ticket-search-test.ts
 *   npx tsx scripts/ticket-search-test.ts --offline    # day math only, no credentials
 *
 * Read-only: every call is a GET. The live half exists because the two things
 * that make this correct are both properties of Freshdesk's API rather than of
 * our code — that `created_at` bounds are day-granular and inclusive on BOTH
 * sides — and a unit test over our own arithmetic would pass whatever Freshdesk
 * decides to do next.
 */
import { searchTickets } from "../lib/tools/freshdesk";
import { shiftDayKey, zonedDayKey, zonedWeekday } from "../lib/tz";

let failures = 0;

function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`);
  }
}

/** Pure: runs without credentials. */
function dayMath() {
  console.log("── day arithmetic ──");
  check("shift back one day", shiftDayKey("2026-08-15", -1) === "2026-08-14");
  check("shift forward one day", shiftDayKey("2026-08-16", 1) === "2026-08-17");
  check("shift across a month boundary", shiftDayKey("2026-08-01", -1) === "2026-07-31");
  check("shift across a year boundary", shiftDayKey("2026-01-01", -1) === "2025-12-31");
  check("malformed day is passed through untouched", shiftDayKey("last saturday", -1) === "last saturday");

  console.log("── weekday in a support timezone ──");
  // 02:00 UTC Monday is still Sunday evening on the US west coast. A UTC-only
  // filter would drop this ticket from a weekend report, and nobody would know.
  const mondayUtc = new Date("2026-08-17T02:00:00Z");
  check("UTC Monday reads as Monday in UTC", zonedWeekday(mondayUtc, "UTC") === "Mon");
  check(
    "…and as Sunday in America/Los_Angeles",
    zonedWeekday(mondayUtc, "America/Los_Angeles") === "Sun",
    `got ${zonedWeekday(mondayUtc, "America/Los_Angeles")}`,
  );
  check("…with the day key rolled back too", zonedDayKey(mondayUtc, "America/Los_Angeles") === "2026-08-16");

  // The same trap in the other direction: 20:00 UTC Saturday is already Sunday
  // in India.
  const satUtc = new Date("2026-08-15T20:00:00Z");
  check("UTC Saturday reads as Saturday in UTC", zonedWeekday(satUtc, "UTC") === "Sat");
  check("…and as Sunday in Asia/Kolkata", zonedWeekday(satUtc, "Asia/Kolkata") === "Sun");
  check("…with the day key rolled forward", zonedDayKey(satUtc, "Asia/Kolkata") === "2026-08-16");
}

/** Live: proves the window Freshdesk applies matches the window we asked for. */
async function liveWindows() {
  console.log("\n── live search windows (read-only) ──");

  // A single day. The query sent is deliberately a day wider at each end, so
  // this is the test that the widening is filtered back out — a leak here shows
  // up as a Friday ticket in a Saturday report.
  const oneDay = await searchTickets({ from: "2026-08-15", to: "2026-08-15" });
  const strays = oneDay.tickets.filter((t) => t.day !== "2026-08-15");
  check(
    `single day returns only that day (${oneDay.tickets.length} tickets)`,
    strays.length === 0,
    strays.map((t) => `#${t.id} ${t.day}`).join(", "),
  );

  // A week, then the same week filtered to weekends. The filtered set must be a
  // subset — if weekends_only ever queries differently rather than filtering,
  // this catches it.
  const week = await searchTickets({ from: "2026-08-10", to: "2026-08-16" });
  const weekend = await searchTickets({ from: "2026-08-10", to: "2026-08-16", weekendsOnly: true });
  const notWeekend = weekend.tickets.filter((t) => t.weekday !== "Sat" && t.weekday !== "Sun");
  check(
    `weekend filter keeps only Sat/Sun (${weekend.tickets.length} of ${week.tickets.length})`,
    notWeekend.length === 0,
    notWeekend.map((t) => `#${t.id} ${t.weekday}`).join(", "),
  );
  const weekIds = new Set(week.tickets.map((t) => t.id));
  check(
    "weekend results are a subset of the full week",
    weekend.tickets.every((t) => weekIds.has(t.id)),
  );
  check(
    "full week agrees with its own weekend count",
    week.tickets.filter((t) => t.weekday === "Sat" || t.weekday === "Sun").length === weekend.tickets.length,
  );

  // Ordering and shape — what the Slack answer is built from.
  const ordered = [...oneDay.tickets].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  check("newest first", JSON.stringify(ordered) === JSON.stringify(oneDay.tickets));
  check(
    "every row carries a ticket link",
    oneDay.tickets.every((t) => /^https:\/\/[^/]+\/a\/tickets\/\d+$/.test(t.url)),
    oneDay.tickets.map((t) => t.url)[0],
  );

  // An empty window is an answer, not a failure.
  const future = await searchTickets({ from: "2030-01-05", to: "2030-01-06" });
  check("a window with nothing in it returns empty, not an error", future.tickets.length === 0);

  console.log(`\n  window ${weekend.from} to ${weekend.to} (${weekend.timezone}):`);
  for (const t of weekend.tickets) {
    console.log(`    ${t.weekday} ${t.day}  #${t.id}  ${t.status.padEnd(12)}  ${t.subject.slice(0, 60)}`);
  }
}

async function main() {
  dayMath();
  if (!process.argv.includes("--offline")) {
    if (!process.env.FRESHDESK_API_KEY) {
      console.log("\n  (no FRESHDESK_API_KEY — skipping live windows; pass --env-file=.env.local to run them)");
    } else {
      await liveWindows();
    }
  }
  console.log(failures ? `\n${failures} failed\n` : "\nall passed\n");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
