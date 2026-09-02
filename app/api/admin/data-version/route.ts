/**
 * Change markers for the console's synced datasets (admin-gated).
 *
 * One HGETALL. Pages poll this instead of their real data endpoints and
 * re-fetch only when a watched marker moved — see lib/data-version.ts for why
 * polling the data endpoints themselves is off the table.
 */
import { NextRequest, NextResponse } from "next/server";
import { adminAuthorized } from "@/lib/auth";
import { getDataVersions } from "@/lib/data-version";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ versions: await getDataVersions() });
}
