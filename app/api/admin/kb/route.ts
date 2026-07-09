/**
 * KB management API (admin-gated) over the unified article store.
 *
 *   GET    /api/admin/kb?state=&category=&q=   → { articles, categories, byState, stale }
 *   POST   /api/admin/kb                       → create (default state "published" for console adds)
 *   PUT    /api/admin/kb                       → update content/metadata (versioned + audited)
 *   DELETE /api/admin/kb?id=...                → delete
 *
 * Lifecycle transitions live at /api/admin/kb/state; version history at
 * /api/admin/kb/versions; audit at /api/admin/kb/audit. Vector-index sync is
 * handled inside the store (published ⇔ searchable).
 */
import { NextRequest, NextResponse } from "next/server";
import { adminAuthorized, adminActor } from "@/lib/auth";
import {
  getArticle,
  listArticles,
  createArticle,
  updateArticle,
  deleteArticle,
  listCategories,
  countByState,
  listStaleArticles,
  ARTICLE_STATES,
  type ArticleState,
  type ArticlePatch,
  type KbArticle,
} from "@/lib/kb-store";
import { getKbUsage } from "@/lib/kv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function textFilter(articles: KbArticle[], q: string): KbArticle[] {
  const needle = q.toLowerCase();
  return articles.filter(
    (a) =>
      a.title.toLowerCase().includes(needle) ||
      a.body.toLowerCase().includes(needle) ||
      a.keywords.some((k) => k.toLowerCase().includes(needle)) ||
      a.tags.some((t) => t.toLowerCase().includes(needle)),
  );
}

export async function GET(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sp = req.nextUrl.searchParams;

  // Single-article fetch for the editor view.
  const id = sp.get("id");
  if (id) {
    const article = await getArticle(id);
    if (!article) return NextResponse.json({ error: "not found" }, { status: 404 });
    const [categories, usage] = await Promise.all([
      listCategories(),
      getKbUsage().catch(() => ({}) as Awaited<ReturnType<typeof getKbUsage>>),
    ]);
    return NextResponse.json({ article, categories, usage: usage[id] ?? null });
  }

  const state = sp.get("state") as ArticleState | null;
  if (state && !ARTICLE_STATES.includes(state)) {
    return NextResponse.json({ error: `state must be one of ${ARTICLE_STATES.join(", ")}` }, { status: 400 });
  }
  const category = sp.get("category") ?? undefined;
  const q = sp.get("q") ?? undefined;

  let articles = await listArticles({ state: state ?? undefined, category, limit: 500 });
  if (q) articles = textFilter(articles, q);

  const [categories, byState, staleList, usage] = await Promise.all([
    listCategories(),
    countByState(),
    listStaleArticles(),
    getKbUsage().catch(() => ({})),
  ]);
  return NextResponse.json({
    articles,
    categories,
    byState,
    stale: staleList.map((a) => a.id),
    usage,
  });
}

export async function POST(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as Partial<KbArticle>;
  if (!b.title || !b.body) {
    return NextResponse.json({ error: "title and body are required" }, { status: 400 });
  }
  if (b.state && !ARTICLE_STATES.includes(b.state)) {
    return NextResponse.json({ error: `state must be one of ${ARTICLE_STATES.join(", ")}` }, { status: 400 });
  }
  const article = await createArticle({
    title: b.title,
    url: b.url ?? "",
    body: b.body,
    keywords: b.keywords ?? [],
    category: b.category ?? "",
    tags: b.tags ?? [],
    // Console adds go live immediately unless the caller says otherwise —
    // matches the old managed-article behavior.
    state: b.state ?? "published",
    origin: "manual",
    createdBy: adminActor(req) ?? "console",
    reviewBy: b.reviewBy,
  });
  return NextResponse.json({ ok: true, article, duplicates: article.duplicates ?? [] });
}

export async function PUT(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as Partial<KbArticle> & { id?: string };
  if (!b.id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const patch: ArticlePatch = {};
  if (b.title !== undefined) patch.title = b.title;
  if (b.url !== undefined) patch.url = b.url;
  if (b.body !== undefined) patch.body = b.body;
  if (b.keywords !== undefined) patch.keywords = b.keywords;
  if (b.category !== undefined) patch.category = b.category;
  if (b.tags !== undefined) patch.tags = b.tags;
  if ("reviewBy" in b) patch.reviewBy = b.reviewBy;
  const article = await updateArticle(b.id, patch, adminActor(req) ?? "console");
  if (!article) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true, article, duplicates: article.duplicates ?? [] });
}

export async function DELETE(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const ok = await deleteArticle(id, adminActor(req) ?? "console");
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
