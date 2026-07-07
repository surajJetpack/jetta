/**
 * Lifecycle transitions (admin-gated).
 *   POST { id, to: "draft" | "in_review" | "published" | "archived" }
 * The store enforces the state machine and keeps the vector index in sync
 * (published ⇔ searchable by the agent).
 */
import { NextRequest, NextResponse } from "next/server";
import { adminAuthorized } from "@/lib/auth";
import { transitionState, ARTICLE_STATES, type ArticleState } from "@/lib/kb-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id, to } = (await req.json().catch(() => ({}))) as { id?: string; to?: ArticleState };
  if (!id || !to || !ARTICLE_STATES.includes(to)) {
    return NextResponse.json(
      { error: `id and to (${ARTICLE_STATES.join("|")}) required` },
      { status: 400 },
    );
  }
  try {
    const article = await transitionState(id, to, "console");
    return NextResponse.json({ ok: true, article });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "transition failed";
    return NextResponse.json({ error: msg }, { status: msg.includes("not found") ? 404 : 400 });
  }
}
