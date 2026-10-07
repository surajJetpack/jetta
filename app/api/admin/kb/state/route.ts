/**
 * Lifecycle transitions (archiving admin-gated, the rest open to the team).
 *   POST { id, to: "draft" | "in_review" | "published" | "archived" }
 * The store enforces the state machine and keeps the vector index in sync
 * (published ⇔ searchable by the agent).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/roles";
import { adminAuthorized, adminActor } from "@/lib/auth";
import { transitionState, ARTICLE_STATES, type ArticleState } from "@/lib/kb-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The transitions only an admin may make. Everything else — drafting, sending
 * something for review, publishing, pulling it back to draft — is ordinary
 * support work and stays open to general users; blocking it would mean the KB
 * only grows as fast as one person reviews it.
 *
 * Publishing was admin-only until 2026-10-07, when the review queue opened to
 * the whole team (see lib/roles.ts). Archiving stays here: it silently removes
 * an answer Jetta was relying on, nothing on the console shows it happened,
 * and the one place it is offered is the article editor, not the queue.
 */
const ADMIN_ONLY_STATES: ArticleState[] = ["archived"];

export async function POST(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id, to } = (await req.json().catch(() => ({}))) as { id?: string; to?: ArticleState };
  if (!id || !to || !ARTICLE_STATES.includes(to)) {
    return NextResponse.json(
      { error: `id and to (${ARTICLE_STATES.join("|")}) required` },
      { status: 400 },
    );
  }
  if (ADMIN_ONLY_STATES.includes(to)) {
    const denied = requireAdmin(req);
    if (denied) return denied;
  }
  try {
    const article = await transitionState(id, to, adminActor(req) ?? "console");
    return NextResponse.json({ ok: true, article });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "transition failed";
    return NextResponse.json({ error: msg }, { status: msg.includes("not found") ? 404 : 400 });
  }
}
