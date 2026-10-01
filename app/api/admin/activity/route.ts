/**
 * The /activity page's data (admin only — every row names a person).
 *
 * GET computes the scorecard and one page of the timeline from the activity
 * store for the chosen window: ?days=1|7|28, plus timeline filters ?person=
 * (a scorecard key), ?place=, ?column= and ?before=<ms> for the next page.
 * POST runs one activity sync now (Slack, monday, KB — the same as the cron).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/roles";
import { adminActor } from "@/lib/auth";
import { config } from "@/lib/config";
import { logOpsEvent } from "@/lib/events";
import { supportTimeZone } from "@/lib/tz";
import {
  buildScorecard,
  COLUMNS,
  filterTimeline,
  parseAliases,
  PLACES,
  resolvePerson,
  type ColumnId,
  type Place,
} from "@/lib/activity";
import { getActivityState, getSlackNames, loadActivities } from "@/lib/activity-store";
import { syncActivity } from "@/lib/activity-sync";
import { syncStatus } from "@/lib/performance-sync";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const WINDOWS = [1, 7, 28] as const;
const PAGE = 100;

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const q = req.nextUrl.searchParams;
  const days = WINDOWS.find((w) => String(w) === q.get("days")) ?? 7;
  const place = PLACES.find((p) => p.id === q.get("place"))?.id as Place | undefined;
  const column = COLUMNS.find((c) => c.id === q.get("column"))?.id as ColumnId | undefined;
  const person = q.get("person") || undefined;
  const before = Number(q.get("before")) || Infinity;

  const sinceMs = Date.now() - days * 86_400_000;
  const [acts, slackNames, state, perf] = await Promise.all([
    loadActivities(sinceMs),
    getSlackNames(),
    getActivityState(),
    syncStatus().catch(() => null),
  ]);
  const aliases = parseAliases(config.agentAliases);
  const opts = { aliases, slackNames, tz: supportTimeZone() };

  const scorecard = buildScorecard(acts, opts);
  const filtered = filterTimeline(acts, { person, place, column }, opts);
  const page = filtered.filter((a) => a.at < before).slice(0, PAGE);
  const timeline = page.map((a) => ({ ...a, person: resolvePerson(a.who, aliases, slackNames) }));

  return NextResponse.json({
    days,
    timeZone: opts.tz,
    scorecard,
    timeline,
    matching: filtered.length,
    nextBefore: page.length === PAGE ? page[page.length - 1].at : null,
    sync: {
      lastRunAt: state.lastRunAt ?? null,
      sources: state.sources ?? {},
      mondaySelf: state.mondaySelf ?? null,
      // Freshdesk rides the performance sync: its queue is how far behind replies are.
      freshdesk: perf ? { lastRunAt: perf.lastRunAt, queued: perf.queued, lastError: perf.lastError } : null,
    },
    aliasesConfigured: aliases.size > 0,
  });
}

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const result = await syncActivity();
  await logOpsEvent({
    level: result.status === "partial" ? "warn" : "info",
    event: "activity.sync_manual",
    source: "console",
    actor: adminActor(req) ?? undefined,
    data: { status: result.status, added: result.added, pruned: result.pruned },
  });
  if (result.status === "busy") {
    return NextResponse.json({ ...result, message: "A sync is already running — try again in a minute." }, { status: 409 });
  }
  return NextResponse.json(result);
}
