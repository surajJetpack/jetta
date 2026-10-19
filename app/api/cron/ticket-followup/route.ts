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
import { config } from "@/lib/config";
import { READ_BUDGET, runTicketFollowUps } from "@/lib/ticket-followup-run";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  // Fails CLOSED: this route writes to customers.
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const p = req.nextUrl.searchParams;
  const dry = p.get("dry") === "1";
  const armed = config.ticketFollowUp;
  if (!config.freshdesk.live) return NextResponse.json({ armed, dry, skipped: "freshdesk not live" });

  // A dry run may pretend it's later, to see what she'd write once touches fall due.
  const asOf = dry ? Date.parse(p.get("asOf") ?? "") : NaN;
  const result = await runTicketFollowUps({
    write: armed && !dry,
    preview: dry && p.get("preview") === "1",
    now: Number.isFinite(asOf) ? asOf : Date.now(),
    // A dry run may read more threads, to see further down the queue at once.
    readBudget: dry ? Math.min(Number(p.get("reads")) || READ_BUDGET, 25) : READ_BUDGET,
  });
  return NextResponse.json({ armed, dry, ...result });
}
