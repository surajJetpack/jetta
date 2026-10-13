/**
 * POST {itemId} — draft a KB article from a dev item's conversation.
 *
 * The person pressing the button is the gate: the miner flags lessons, it never
 * files them. The article lands as a DRAFT in the review queue (POST
 * /api/admin/kb defaults to published — this never goes through it), linked
 * back to the item so the page shows "Draft made" and nobody drafts it twice.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireUnderstand } from "@/lib/roles";
import { adminActor } from "@/lib/auth";
import { logOpsEvent } from "@/lib/events";
import { createArticle } from "@/lib/kb-store";
import { draftKbArticle } from "@/lib/knowledge-loop";
import { threadText } from "@/lib/dev-board";
import { getDevBoardState, getDevItem, getMined, namesOf, rebuildDevBoard, rosterFor, saveMined } from "@/lib/dev-board-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const denied = requireUnderstand(req);
  if (denied) return denied;
  const actor = adminActor(req) ?? "console";
  const { itemId } = (await req.json().catch(() => ({}))) as { itemId?: string };
  if (!itemId) return NextResponse.json({ error: "itemId is required" }, { status: 400 });

  const [item, mined, state] = await Promise.all([getDevItem(itemId), getMined(itemId), getDevBoardState()]);
  if (!item || !state.self) return NextResponse.json({ error: "not_found", message: "That item isn't in the dev-board store." }, { status: 404 });
  if (mined?.kbDraftId) return NextResponse.json({ ok: true, articleId: mined.kbDraftId, existing: true });

  const thread = threadText(item, rosterFor(state.self), namesOf([item]));
  const hint = mined?.lesson
    ? `\n\nWhat a reviewer took from this thread (use it only where the thread supports it):\nQuestion: ${mined.kbTitle ?? ""}\nAnswer: ${mined.lesson}`
    : "";
  try {
    const draft = await draftKbArticle(`${thread}${hint}`);
    const article = await createArticle({
      title: mined?.kbTitle || draft.title,
      body: draft.body,
      keywords: draft.keywords,
      tags: ["dev-board", item.board],
      state: "draft",
      origin: "knowledge-loop",
      source: "dev-board",
      product: item.board === "getsign" ? "getsign" : "jetpackapps",
      createdBy: actor,
      meta: { devItemId: item.id },
    });
    if (mined) await saveMined(item.id, { ...mined, kbDraftId: article.id });
    await rebuildDevBoard().catch(() => {});
    await logOpsEvent({
      level: "info",
      event: "devboard.kb_drafted",
      source: "console",
      actor,
      data: { itemId: item.id, articleId: article.id, duplicates: article.duplicates?.length ?? 0 },
    });
    return NextResponse.json({ ok: true, articleId: article.id, duplicates: article.duplicates ?? [] });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await logOpsEvent({ level: "error", event: "devboard.kb_draft_failed", source: "console", actor, data: { itemId, message } });
    return NextResponse.json({ error: "draft_failed", message: "Couldn't draft the article — try again." }, { status: 502 });
  }
}
