/**
 * KB management API (admin-gated). Manages the editable "managed" layer; the
 * curated GetSign corpus is returned read-only. Every managed write syncs to
 * the Upstash Vector index.
 *
 *   GET    /api/admin/kb            → { curated[], managed[] }
 *   POST   /api/admin/kb            → create a managed article
 *   PUT    /api/admin/kb            → update a managed article (by id)
 *   DELETE /api/admin/kb?id=...     → delete a managed article
 */
import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { adminAuthorized } from "@/lib/auth";
import {
  listManagedArticles,
  getManagedArticle,
  upsertManagedArticle,
  deleteManagedArticle,
  type ManagedArticle,
} from "@/lib/kv";
import { GETSIGN_KB } from "@/lib/knowledge/getsign-kb";
import { vectorEnabled, upsertDocs, deleteDocs } from "@/lib/vector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const managed = await listManagedArticles();
  const curated = GETSIGN_KB.map((a) => ({
    title: a.title,
    url: a.url,
    body: a.body,
    keywords: a.keywords ?? [],
    source: a.source,
  }));
  return NextResponse.json({ curated, managed });
}

export async function POST(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as Partial<ManagedArticle>;
  if (!b.title || !b.body) {
    return NextResponse.json({ error: "title and body are required" }, { status: 400 });
  }
  const article: ManagedArticle = {
    id: `manual-${crypto.randomUUID()}`,
    title: b.title,
    url: b.url ?? "",
    body: b.body,
    keywords: b.keywords ?? [],
    origin: "manual",
    createdBy: "console",
    at: Math.floor(Date.now() / 1000),
  };
  await upsertManagedArticle(article);
  if (vectorEnabled()) {
    await upsertDocs([{ id: article.id, title: article.title, url: article.url, body: article.body, source: "managed" }]).catch(
      () => {},
    );
  }
  return NextResponse.json({ ok: true, article });
}

export async function PUT(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as Partial<ManagedArticle>;
  if (!b.id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const existing = await getManagedArticle(b.id);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  const article: ManagedArticle = {
    ...existing,
    title: b.title ?? existing.title,
    url: b.url ?? existing.url,
    body: b.body ?? existing.body,
    keywords: b.keywords ?? existing.keywords,
  };
  await upsertManagedArticle(article);
  if (vectorEnabled()) {
    await upsertDocs([{ id: article.id, title: article.title, url: article.url, body: article.body, source: "managed" }]).catch(
      () => {},
    );
  }
  return NextResponse.json({ ok: true, article });
}

export async function DELETE(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  await deleteManagedArticle(id);
  if (vectorEnabled()) await deleteDocs([id]).catch(() => {});
  return NextResponse.json({ ok: true });
}
