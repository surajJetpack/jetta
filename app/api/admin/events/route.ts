/**
 * Unified ops event log (admin-gated).
 *
 *   GET → { events }                        newest-first JSON for the console
 *   GET ?format=ndjson                      OLDEST-first NDJSON — the shape
 *                                           meant for AI/offline analysis
 *
 * Filters: limit (≤1000), level, event (prefix, e.g. "webhook."), source,
 * ticketId, since (unix ms).
 */
import { NextRequest, NextResponse } from "next/server";
import { adminAuthorized } from "@/lib/auth";
import { getOpsEvents, type EventLevel, type OpsEvent } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LEVELS: EventLevel[] = ["info", "warn", "error"];
const SOURCES: OpsEvent["source"][] = ["webhook", "freshchat", "console", "cron", "slack", "auth", "app"];

export async function GET(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const p = req.nextUrl.searchParams;

  const level = p.get("level");
  const source = p.get("source");
  const since = Number(p.get("since"));
  const events = await getOpsEvents({
    limit: Math.min(Number(p.get("limit")) || 200, 1000),
    level: LEVELS.includes(level as EventLevel) ? (level as EventLevel) : undefined,
    event: p.get("event") ?? undefined,
    source: SOURCES.includes(source as OpsEvent["source"]) ? (source as OpsEvent["source"]) : undefined,
    ticketId: p.get("ticketId") ?? undefined,
    sinceMs: Number.isFinite(since) && since > 0 ? since : undefined,
  });

  if (p.get("format") === "ndjson") {
    // Chronological order (oldest first) — the natural shape for analysis.
    const body = [...events].reverse().map((e) => JSON.stringify(e)).join("\n") + "\n";
    return new NextResponse(body, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Content-Disposition": "attachment; filename=jetta-events.ndjson",
      },
    });
  }
  return NextResponse.json({ events });
}
