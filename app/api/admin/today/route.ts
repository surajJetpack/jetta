/**
 * Morning-brief data for /today. The assembly lives in lib/today.ts so the
 * AI insight route narrates the identical payload.
 */
import { NextRequest, NextResponse } from "next/server";
import { buildTodayBrief } from "@/lib/today";
import { adminAuthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!adminAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const brand = req.nextUrl.searchParams.get("brand");
  return NextResponse.json(
    await buildTodayBrief(brand === "getsign" || brand === "jetpackapps" ? brand : null),
  );
}
