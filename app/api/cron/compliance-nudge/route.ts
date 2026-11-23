/**
 * Hourly: a Slack direct message to the compliance contact about requests on
 * the Security Questionnaires board that are waiting on him
 * (lib/compliance-nudge.ts). New ones at once, reminders every two working
 * days, one message per run.
 *
 * JETTA_COMPLIANCE_NUDGE gates it; off returns at once. `?dry=1` reports what
 * it would send without sending, logging or saving, whatever the mode.
 */
import { NextRequest, NextResponse } from "next/server";
import { runComplianceNudge } from "@/lib/compliance-nudge";
import { config } from "@/lib/config";
import { withCronBeat } from "@/lib/cron-beat";
import { cronAuthorized } from "@/lib/request-auth";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

async function handler(req: NextRequest) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const mode = config.complianceNudge;
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  if (mode === "off" && !dry) return NextResponse.json({ mode });
  const run = await runComplianceNudge(new Date(), { dry });
  const acted = run.rows.filter((r) => r.decision.action !== "none");
  return NextResponse.json({ mode, ...(dry ? { dry: true } : {}), items: run.rows.length, acted, text: acted.length ? run.text : undefined });
}

export const GET = withCronBeat("compliance-nudge", handler);
