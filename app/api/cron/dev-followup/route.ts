/**
 * Daily: ask developers for an update on quiet dev items a customer is
 * waiting on (lib/dev-followup.ts). JETTA_DEV_FOLLOWUP gates it; off returns
 * at once. `?dry=1` reports the decisions without acting, whatever the mode.
 */
import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { logOpsEvent } from "@/lib/events";
import { decideFollowUp, runDevFollowUp } from "@/lib/dev-followup";
import * as monday from "@/lib/tools/monday";
import * as freshdesk from "@/lib/tools/freshdesk";

export const runtime = "nodejs";
export const maxDuration = 300;

function authorized(req: NextRequest): boolean {
  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET is set.
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (req.nextUrl.searchParams.get("dry") === "1") {
    const now = new Date();
    const rows = [];
    for (const { id, ticketIds } of await monday.liveLinkedItemIds()) {
      const item = await monday.getDevItemSnapshot(id).catch(() => null);
      if (!item) continue;
      const status = await freshdesk.getTicketStatus(ticketIds[0]);
      rows.push({ itemId: id, name: item.name, ticketId: ticketIds[0], ticketStatus: status, devStatus: item.devStatus, decision: decideFollowUp(item, status, now, config.devFollowUpRules) });
    }
    return NextResponse.json({ mode: config.devFollowUp, dry: true, rows });
  }

  if (config.devFollowUp === "off") return NextResponse.json({ mode: "off" });
  const rows = await runDevFollowUp();
  const acted = rows.filter((r) => r.done);
  await logOpsEvent({
    level: "info",
    event: "cron.dev_followup_run",
    source: "cron",
    data: { mode: config.devFollowUp, items: rows.length, acted: acted.map((r) => ({ itemId: r.itemId, ticketId: r.ticketId, done: r.done })) },
  });
  return NextResponse.json({ mode: config.devFollowUp, items: rows.length, acted });
}
