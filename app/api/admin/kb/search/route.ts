/** Test retrieval: query → vector hits + scores (admin-gated). */
import { NextRequest, NextResponse } from "next/server";
import { adminAuthorized } from "@/lib/auth";
import { vectorEnabled, queryVector } from "@/lib/vector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q) return NextResponse.json({ error: "q is required" }, { status: 400 });
  if (!vectorEnabled()) return NextResponse.json({ vectorEnabled: false, hits: [] });
  const hits = await queryVector(q, 8).catch(() => []);
  return NextResponse.json({ vectorEnabled: true, hits });
}
