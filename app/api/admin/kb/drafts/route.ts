/**
 * Knowledge-Loop draft approval queue (admin-gated).
 *   GET  → pending drafts
 *   POST { id, action: "approve" | "reject" }
 * Approve promotes the draft into the managed KB + vector index; reject discards.
 */
import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { adminAuthorized } from "@/lib/auth";
import { listDrafts, getDraft, deleteDraft, upsertManagedArticle } from "@/lib/kv";
import { vectorEnabled, upsertDocs } from "@/lib/vector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ drafts: await listDrafts() });
}

export async function POST(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id, action } = (await req.json().catch(() => ({}))) as { id?: string; action?: string };
  if (!id || (action !== "approve" && action !== "reject")) {
    return NextResponse.json({ error: "id and action (approve|reject) required" }, { status: 400 });
  }
  const draft = await getDraft(id);
  if (!draft) return NextResponse.json({ error: "draft not found" }, { status: 404 });

  if (action === "reject") {
    await deleteDraft(id);
    return NextResponse.json({ ok: true, action: "rejected" });
  }

  const articleId = `loop-${crypto.randomUUID()}`;
  await upsertManagedArticle({
    id: articleId,
    title: draft.title,
    url: "",
    body: draft.body,
    keywords: draft.keywords,
    origin: "knowledge-loop",
    createdBy: "console",
    at: Math.floor(Date.now() / 1000),
  });
  if (vectorEnabled()) {
    await upsertDocs([{ id: articleId, title: draft.title, url: "", body: draft.body, source: "managed" }]).catch(() => {});
  }
  await deleteDraft(id);
  return NextResponse.json({ ok: true, action: "approved", articleId });
}
