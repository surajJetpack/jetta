/**
 * Daily KB sync cron: mirror jetpackapps.io + getsign.io into the KB store
 * (new pages published, changed pages updated unless human-edited, removed
 * pages archived). Slack summary only when something changed or was flagged.
 * Scheduled in vercel.json (05:00 UTC); also invocable manually with the
 * CRON_SECRET bearer token.
 */
import { NextRequest, NextResponse } from "next/server";
import { SITES, syncSite, type SyncResult } from "@/lib/kb-sync";
import { notifyKbSync } from "@/lib/tools/slack";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET is set.
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const results: SyncResult[] = [];
  const errors: string[] = [];
  for (const site of SITES) {
    try {
      results.push(await syncSite(site));
    } catch (e) {
      const msg = `${site.key}: ${e instanceof Error ? e.message : String(e)}`;
      errors.push(msg);
      console.error("kb-sync failed for", msg);
    }
  }

  const eventful =
    errors.length > 0 ||
    results.some(
      (r) => r.created || r.updated || r.archived || r.skippedHumanEdited.length || r.flagged.length,
    );
  if (eventful) {
    const lines = results.map(
      (r) =>
        `*${r.site}*: ${r.crawled} crawled · +${r.created} new · ${r.updated} updated · ${r.archived} archived` +
        (r.skippedHumanEdited.length ? ` · ${r.skippedHumanEdited.length} skipped (human-edited)` : "") +
        (r.flagged.length ? `\n:warning: ${r.flagged.join("; ")}` : ""),
    );
    if (errors.length) lines.push(`:x: ${errors.join("; ")}`);
    await notifyKbSync(lines).catch((e) => console.warn("kb-sync slack ping failed:", e));
  }

  return NextResponse.json({ results, errors });
}
