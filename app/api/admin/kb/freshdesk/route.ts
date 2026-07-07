/**
 * Freshdesk Solutions publishing (admin-gated) — one-way push of PUBLISHED
 * articles into the customer-facing help center. Manual button, no auto-sync.
 *
 *   GET  → { folders, categories }        Freshdesk folders + category→folder map
 *   PUT  { slug, fdFolderId }             save a category → folder mapping
 *   POST { id }                           push one article (create or update,
 *                                         decided by the stored freshdesk.articleId;
 *                                         a 404 on update falls back to create)
 *
 * STUB_MODE: folder list and pushes return stubs so the flow is testable
 * without credentials.
 */
import { NextRequest, NextResponse } from "next/server";
import { adminAuthorized } from "@/lib/auth";
import {
  getArticle,
  listCategories,
  upsertCategory,
  setFreshdeskSync,
  recordAudit,
} from "@/lib/kb-store";
import {
  listSolutionFolders,
  createSolutionArticle,
  updateSolutionArticle,
  textToFdHtml,
} from "@/lib/tools/freshdesk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const [folders, categories] = await Promise.all([
    listSolutionFolders().catch(() => []),
    listCategories(),
  ]);
  return NextResponse.json({ folders, categories });
}

export async function PUT(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { slug, fdFolderId } = (await req.json().catch(() => ({}))) as { slug?: string; fdFolderId?: string };
  if (!slug) return NextResponse.json({ error: "slug is required" }, { status: 400 });
  const cat = (await listCategories()).find((c) => c.slug === slug);
  if (!cat) return NextResponse.json({ error: "unknown category" }, { status: 404 });
  await upsertCategory({ ...cat, fdFolderId: fdFolderId || undefined });
  return NextResponse.json({ ok: true });
}

export async function POST(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = (await req.json().catch(() => ({}))) as { id?: string };
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const article = await getArticle(id);
  if (!article) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (article.state !== "published") {
    return NextResponse.json({ error: "only published articles can be pushed to Freshdesk" }, { status: 400 });
  }
  const cat = (await listCategories()).find((c) => c.slug === article.category);
  if (!cat?.fdFolderId) {
    return NextResponse.json(
      { error: `map category "${article.category || "(uncategorized)"}" to a Freshdesk folder first` },
      { status: 400 },
    );
  }

  const payload = { title: article.title, html: textToFdHtml(article.body), status: 2 as const };
  try {
    let ref;
    if (article.freshdesk?.articleId) {
      try {
        ref = await updateSolutionArticle(article.freshdesk.articleId, payload);
      } catch (e) {
        if (e instanceof Error && e.message === "fd-article-gone") {
          ref = await createSolutionArticle(cat.fdFolderId, payload);
        } else {
          throw e;
        }
      }
    } else {
      ref = await createSolutionArticle(cat.fdFolderId, payload);
    }
    const updated = await setFreshdeskSync(
      id,
      { articleId: ref.id, folderId: cat.fdFolderId, syncedAt: Math.floor(Date.now() / 1000), syncedVersion: article.version },
      "console",
    );
    return NextResponse.json({ ok: true, freshdesk: updated?.freshdesk, url: ref.url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "push failed";
    await recordAudit({
      at: Math.floor(Date.now() / 1000),
      actor: "console",
      articleId: id,
      title: article.title,
      action: "fd_push_error",
      detail: msg.slice(0, 300),
    });
    return NextResponse.json({ error: `Freshdesk push failed: ${msg}` }, { status: 502 });
  }
}
