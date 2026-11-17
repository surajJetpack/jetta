/**
 * Hourly: read what the GetSign team merged into production and act on it
 * (lib/release-watch.ts). JETTA_RELEASE_WATCH gates it; off returns at once.
 *
 * `?dry=1` reads and decides without writing or moving the cursor, whatever
 * the mode. Add `&since=2026-11-08` to preview a past release.
 */
import { NextRequest, NextResponse } from "next/server";
import { withCronBeat } from "@/lib/cron-beat";
import { config } from "@/lib/config";
import { runReleaseWatch } from "@/lib/release-watch";
import { cronAuthorized } from "@/lib/request-auth";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

async function handler(req: NextRequest) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (req.nextUrl.searchParams.get("dry") === "1") {
    const raw = req.nextUrl.searchParams.get("since");
    const at = raw ? new Date(raw) : null;
    if (at && Number.isNaN(at.getTime())) return NextResponse.json({ error: "since is not a date" }, { status: 400 });
    return NextResponse.json(await runReleaseWatch({ dryRun: true, since: at?.toISOString() }));
  }

  if (config.releaseWatch === "off") return NextResponse.json({ mode: "off" });
  return NextResponse.json(await runReleaseWatch());
}

export const GET = withCronBeat("release-watch", handler);
