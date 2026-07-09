/**
 * Bulk article actions (admin-gated).
 *   POST { ids: string[], action: "publish" | "archive" | "delete" | "reingest" }
 * Best-effort per id: illegal transitions are reported, not fatal.
 * "reingest" re-upserts published articles into the vector index.
 */
import { NextRequest, NextResponse } from "next/server";
import { adminAuthorized, adminActor } from "@/lib/auth";
import { getArticle, transitionState, deleteArticle } from "@/lib/kb-store";
import { vectorEnabled, upsertDocs } from "@/lib/vector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIONS = ["publish", "archive", "delete", "reingest"] as const;
type Action = (typeof ACTIONS)[number];

export async function POST(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { ids, action } = (await req.json().catch(() => ({}))) as { ids?: string[]; action?: Action };
  if (!Array.isArray(ids) || !ids.length || !action || !ACTIONS.includes(action)) {
    return NextResponse.json({ error: `ids[] and action (${ACTIONS.join("|")}) required` }, { status: 400 });
  }
  if (ids.length > 100) return NextResponse.json({ error: "max 100 ids per call" }, { status: 400 });

  let ok = 0;
  const failed: { id: string; error: string }[] = [];
  for (const id of ids) {
    try {
      switch (action) {
        case "publish":
          await transitionState(id, "published", adminActor(req) ?? "console");
          break;
        case "archive":
          await transitionState(id, "archived", adminActor(req) ?? "console");
          break;
        case "delete":
          if (!(await deleteArticle(id, adminActor(req) ?? "console"))) throw new Error("not found");
          break;
        case "reingest": {
          const a = await getArticle(id);
          if (!a) throw new Error("not found");
          if (a.state !== "published") throw new Error("only published articles are ingested");
          if (vectorEnabled()) {
            await upsertDocs([{ id: a.id, title: a.title, url: a.url, body: a.body, source: a.source }]);
          }
          break;
        }
      }
      ok++;
    } catch (e) {
      failed.push({ id, error: e instanceof Error ? e.message : "failed" });
    }
  }
  return NextResponse.json({ ok, failed });
}
