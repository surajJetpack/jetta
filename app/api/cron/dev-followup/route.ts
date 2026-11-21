/**
 * Daily: ask developers for an update on quiet dev items a customer is
 * waiting on (lib/dev-followup.ts). JETTA_DEV_FOLLOWUP gates it; off returns
 * at once. JETTA_DEV_FOLLOWUP_UNLINKED adds items with no ticket link.
 * The support side and the product manager have their own hourly cron
 * (app/api/cron/dev-followup-support).
 * `?dry=1` reports the decisions without acting, whatever the mode.
 */
import { NextRequest, NextResponse } from "next/server";
import { withCronBeat } from "@/lib/cron-beat";
import { config } from "@/lib/config";
import { logOpsEvent } from "@/lib/events";
import { planDevFollowUp, runDevFollowUp } from "@/lib/dev-followup";
import { cronAuthorized } from "@/lib/request-auth";

export const runtime = "nodejs";
export const maxDuration = 300;

async function handler(req: NextRequest) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (req.nextUrl.searchParams.get("dry") === "1") {
    // Unlinked items are planned whatever their switch says, so a dry run
    // previews them before anyone turns it on.
    const plan = await planDevFollowUp(new Date(), { unlinked: true });
    const rows = plan.map(({ item, ticketId, ticketStatus, decision }) => ({
      itemId: item.id,
      name: item.name,
      group: item.group,
      ticketId,
      ticketStatus,
      devStatus: item.devStatus,
      decision,
    }));
    return NextResponse.json({ mode: config.devFollowUp, unlinkedMode: config.devFollowUpUnlinked, dry: true, rows });
  }

  if (config.devFollowUp === "off") return NextResponse.json({ mode: "off" });
  const rows = await runDevFollowUp();
  const acted = rows.filter((r) => r.done);
  await logOpsEvent({
    level: "info",
    event: "cron.dev_followup_run",
    source: "cron",
    data: { mode: config.devFollowUp, unlinkedMode: config.devFollowUpUnlinked, items: rows.length, acted: acted.map((r) => ({ itemId: r.itemId, ticketId: r.ticketId, done: r.done })) },
  });
  return NextResponse.json({ mode: config.devFollowUp, unlinkedMode: config.devFollowUpUnlinked, items: rows.length, acted });
}

export const GET = withCronBeat("dev-followup", handler);
