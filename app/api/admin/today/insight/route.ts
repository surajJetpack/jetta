/**
 * The AI briefing for /today.
 *
 * Its own endpoint rather than a field on the brief: assembling the brief
 * already takes a couple of seconds, and making every reader wait on an LLM
 * call on top of that would make the page feel broken. The client renders the
 * numbers immediately and drops this in when it lands.
 *
 * Cached against a fingerprint of the brief (not a timer), so a morning where
 * ten people open the page costs one generation, while a spike appearing at
 * 09:15 isn't missing from a briefing frozen at 09:05.
 */
import { NextRequest, NextResponse } from "next/server";
import { buildTodayBrief } from "@/lib/today";
import { generateTodayInsight, briefFingerprint, type TodayInsight } from "@/lib/today-insight";
import { getDailyRollup, saveTodayInsight, getTodayInsight } from "@/lib/kv";
import { yesterdayKey } from "@/lib/daily-overview";
import { adminAuthorized, adminActor } from "@/lib/auth";
import { logOpsEvent } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const readCache = () => getTodayInsight<TodayInsight>().catch(() => null);

export async function GET(req: NextRequest) {
  if (!adminAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const force = req.nextUrl.searchParams.get("refresh") === "1";

  const brief = await buildTodayBrief();
  const fingerprint = briefFingerprint(brief);

  if (!force) {
    const cached = await readCache();
    if (cached?.fingerprint === fingerprint) {
      return NextResponse.json({ insight: cached.insight, cached: true });
    }
  }

  try {
    const yesterday = await getDailyRollup(yesterdayKey()).catch(() => null);
    const insight = await generateTodayInsight(brief, yesterday);
    await saveTodayInsight({ fingerprint, insight }).catch(() => {});
    await logOpsEvent({
      level: "info",
      event: "today.insight_generated",
      source: "console",
      actor: adminActor(req) ?? undefined,
      data: { arrived: brief.summary.arrived, emerging: brief.trends.emerging.length, forced: force },
    });
    return NextResponse.json({ insight, cached: false });
  } catch (e) {
    // A missing narrative must never take the brief down with it — the numbers
    // are the page, this is commentary on them. Serve a stale one if we have it.
    const stale = await readCache();
    const error = e instanceof Error ? e.message : String(e);
    await logOpsEvent({ level: "warn", event: "today.insight_failed", source: "console", data: { error } });
    return NextResponse.json({ insight: stale?.insight ?? null, cached: !!stale, stale: !!stale, error });
  }
}
