/**
 * Hourly: the support side of the dev boards, and the product manager
 * (lib/dev-followup-support.ts). A developer update the customer has not been
 * told about gets an ask to the support person on the item at once; a new
 * feature request brings the product manager in.
 *
 * At :55, after the dev board sync (:50) and the performance sync (:40) have
 * refreshed the stores it reads. JETTA_DEV_FOLLOWUP_SUPPORT gates it (and
 * JETTA_DEV_FOLLOWUP must be on); off returns at once. `?dry=1` reports what
 * it would do without posting, logging or saving, whatever the mode.
 */
import { NextRequest, NextResponse } from "next/server";
import { withCronBeat } from "@/lib/cron-beat";
import { config } from "@/lib/config";
import { logOpsEvent } from "@/lib/events";
import { runSupportFollowUp } from "@/lib/dev-followup-support";
import { cronAuthorized } from "@/lib/request-auth";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

async function handler(req: NextRequest) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const mode = config.devFollowUp === "off" ? "off" : config.devFollowUpSupport;

  if (req.nextUrl.searchParams.get("dry") === "1") {
    const rows = (await runSupportFollowUp(new Date(), { dry: true })).filter((r) => r.decision.action !== "none");
    return NextResponse.json({ mode, dry: true, rows });
  }

  if (mode === "off") return NextResponse.json({ mode });
  const rows = await runSupportFollowUp();
  const acted = rows.filter((r) => r.done).map((r) => ({ itemId: r.itemId, ticketId: r.ticketId, what: r.what, done: r.done }));
  // Most hours there is nothing to do; only a run that did something is worth a line in the log.
  if (acted.length) {
    await logOpsEvent({ level: "info", event: "cron.dev_followup_support_run", source: "cron", data: { mode, items: rows.length, acted } });
  }
  return NextResponse.json({ mode, items: rows.length, acted });
}

export const GET = withCronBeat("dev-followup-support", handler);
