/**
 * The AI read for /health — any signed-in console user, like the page.
 *
 * Its own endpoint so the numbers render at once and the read drops in when
 * it lands. Cached against the payload's computedAt: the numbers change only
 * when the hourly sync rebuilds them, so a morning where ten people open the
 * page costs one generation, and a sync that moved the numbers is never
 * narrated by a read written before it. `?refresh=1` rewrites it anyway.
 */
import { NextRequest, NextResponse } from "next/server";
import { adminActor } from "@/lib/auth";
import { getHealthInsight, getSupportHealth, getSupportHealthRows, saveHealthInsight } from "@/lib/performance-sync";
import { generateHealthInsight, type HealthInsight } from "@/lib/health-insight";
import { logOpsEvent } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const actor = adminActor(req);
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const force = req.nextUrl.searchParams.get("refresh") === "1";

  const [health, rows, cached] = await Promise.all([
    getSupportHealth(),
    getSupportHealthRows(),
    getHealthInsight<HealthInsight>().catch(() => null),
  ]);
  if (!health) return NextResponse.json({ insight: null, reason: "no_data" });
  if (!force && cached?.basedOn === health.computedAt) {
    return NextResponse.json({ insight: cached, cached: true });
  }
  // The rows are what every citation opens; without them there is nothing to cite.
  if (!rows) return NextResponse.json({ insight: null, reason: "not_built" });

  const started = Date.now();
  try {
    const insight = await generateHealthInsight(health, rows);
    await saveHealthInsight(insight).catch(() => {});
    await logOpsEvent({
      level: "info",
      event: "health.insight_generated",
      source: "console",
      actor,
      data: { forced: force, ms: Date.now() - started, model: insight.model, dropped: insight.dropped },
    });
    return NextResponse.json({ insight, cached: false });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await logOpsEvent({ level: "error", event: "health.insight_failed", source: "console", actor, data: { message } });
    // A stale read beats none: the numbers under it are still on the page.
    if (cached) return NextResponse.json({ insight: cached, cached: true, stale: true });
    return NextResponse.json({ error: "insight_failed", message: "Couldn't write the analysis — try again." }, { status: 502 });
  }
}
