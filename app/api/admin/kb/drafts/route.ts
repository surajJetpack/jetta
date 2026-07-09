/**
 * Draft review queue (admin-gated) — drafts are simply articles in "draft"
 * state in the unified store (no separate model, no TTL).
 *
 *   GET  → { drafts }  (draft-state articles, newest first)
 *   POST { id, action: "approve" | "reject" }
 *
 * Approve = transition draft → published on the SAME article (id is stable;
 * the store handles the vector upsert). Reject = delete + audit.
 */
import { NextRequest, NextResponse } from "next/server";
import { adminAuthorized, adminActor } from "@/lib/auth";
import { listArticles, transitionState, deleteArticle } from "@/lib/kb-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ drafts: await listArticles({ state: "draft", limit: 200 }) });
}

export async function POST(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id, action } = (await req.json().catch(() => ({}))) as { id?: string; action?: string };
  if (!id || (action !== "approve" && action !== "reject")) {
    return NextResponse.json({ error: "id and action (approve|reject) required" }, { status: 400 });
  }

  if (action === "reject") {
    const ok = await deleteArticle(id, adminActor(req) ?? "console");
    if (!ok) return NextResponse.json({ error: "draft not found" }, { status: 404 });
    return NextResponse.json({ ok: true, action: "rejected" });
  }

  try {
    const article = await transitionState(id, "published", adminActor(req) ?? "console");
    return NextResponse.json({ ok: true, action: "approved", articleId: article.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "approve failed";
    return NextResponse.json({ error: msg }, { status: msg.includes("not found") ? 404 : 400 });
  }
}
