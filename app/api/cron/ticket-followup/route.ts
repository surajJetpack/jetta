/**
 * Follows up with customers who went quiet on a Freshdesk ticket, every 20
 * minutes. The run is lib/ticket-followup-run.ts; the rules and the why are
 * lib/ticket-followup.ts.
 *
 * `?dry=1` reports what it would do and writes nothing (works while disarmed);
 * add `&preview=1` to have her write the due touches too, still sending nothing,
 * `&reads=N` (max 25) to look further down the queue, and `&asOf=<ISO>` to
 * pretend it's later.
 * JETTA_TICKET_FOLLOWUP=on is the arm.
 */
import { NextRequest, NextResponse } from "next/server";
import { withCronBeat } from "@/lib/cron-beat";
import { config } from "@/lib/config";
import { READ_BUDGET, runTicketFollowUps } from "@/lib/ticket-followup-run";
import { cronAuthorized } from "@/lib/request-auth";
import { markEventSeen, unmarkEventSeen } from "@/lib/kv";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

async function handler(req: NextRequest) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const p = req.nextUrl.searchParams;
  const dry = p.get("dry") === "1";
  const armed = config.ticketFollowUp;
  if (!config.freshdesk.live) return NextResponse.json({ armed, dry, skipped: "freshdesk not live" });

  // A dry run may pretend it's later, to see what she'd write once touches fall due.
  const asOf = dry ? Date.parse(p.get("asOf") ?? "") : NaN;
  // One writing run at a time. Two that overlap each read the same state and
  // each post the "following up at HH:MM" note. Shorter than the 20-minute
  // schedule, so a run killed at its limit never blocks the next tick.
  const writing = armed && !dry;
  if (writing && !(await markEventSeen(RUN_LOCK, 290))) {
    return NextResponse.json({ armed, dry, skipped: "another run is in progress" });
  }
  try {
    return NextResponse.json({ armed, dry, ...(await run(armed, dry, asOf, p)) });
  } finally {
    if (writing) await unmarkEventSeen(RUN_LOCK).catch(() => {});
  }
}

const RUN_LOCK = "ticketfollowup-run";

function run(armed: boolean, dry: boolean, asOf: number, p: URLSearchParams) {
  return runTicketFollowUps({
    write: armed && !dry,
    preview: dry && p.get("preview") === "1",
    now: Number.isFinite(asOf) ? asOf : Date.now(),
    // A dry run may read more threads, to see further down the queue at once.
    readBudget: dry ? Math.min(Number(p.get("reads")) || READ_BUDGET, 25) : READ_BUDGET,
  });
}

export const GET = withCronBeat("ticket-followup", handler);
