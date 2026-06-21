/**
 * Admin-gated run-log feed. Recent runs, or a single ticket's history via
 * ?ticketId=. Powers the Activity Log view in the ops console.
 */
import { NextRequest, NextResponse } from "next/server";
import { getRunLogs, getRunLogsByTicket } from "@/lib/kv";
import { adminAuthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!adminAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const ticketId = req.nextUrl.searchParams.get("ticketId");
  const logs = ticketId ? await getRunLogsByTicket(ticketId) : await getRunLogs(100);
  return NextResponse.json({ logs });
}
