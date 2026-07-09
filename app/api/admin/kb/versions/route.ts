/**
 * Version history (admin-gated).
 *   GET  ?id=...              → { versions } (newest first, capped at 20)
 *   POST { id, version }      → restore that version's content as a NEW version
 */
import { NextRequest, NextResponse } from "next/server";
import { adminAuthorized, adminActor } from "@/lib/auth";
import { listVersions, restoreVersion } from "@/lib/kb-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  return NextResponse.json({ versions: await listVersions(id) });
}

export async function POST(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id, version } = (await req.json().catch(() => ({}))) as { id?: string; version?: number };
  if (!id || typeof version !== "number") {
    return NextResponse.json({ error: "id and version required" }, { status: 400 });
  }
  const article = await restoreVersion(id, version, adminActor(req) ?? "console");
  if (!article) return NextResponse.json({ error: "article or version not found" }, { status: 404 });
  return NextResponse.json({ ok: true, article });
}
