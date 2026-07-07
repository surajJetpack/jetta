/**
 * Audit trail (admin-gated).
 *   GET            → { events } (global feed, capped 1000)
 *   GET ?id=...    → { events } (per-article, capped 100)
 */
import { NextRequest, NextResponse } from "next/server";
import { adminAuthorized } from "@/lib/auth";
import { getAuditFeed, getArticleAudit } from "@/lib/kb-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 100);
  const events = id ? await getArticleAudit(id, limit) : await getAuditFeed(limit);
  return NextResponse.json({ events });
}
