/**
 * Test retrieval (admin-gated): runs the SAME pipeline the agent uses —
 * vector over-fetch → LLM rerank → top hits — with per-stage timings so the
 * console can show raw-vs-reranked. `?rerank=0` skips the reranker; keyword
 * fallback is used automatically when the vector store is unconfigured.
 */
import { NextRequest, NextResponse } from "next/server";
import { adminAuthorized } from "@/lib/auth";
import { vectorEnabled, queryVector, type VectorHit } from "@/lib/vector";
import { searchPublishedKb } from "@/lib/kb-store";
import { rerankHits, rerankEnabled } from "@/lib/rerank";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q) return NextResponse.json({ error: "q is required" }, { status: 400 });
  const wantRerank = req.nextUrl.searchParams.get("rerank") !== "0";

  if (!vectorEnabled()) {
    const t0 = Date.now();
    const hits = await searchPublishedKb(q, 8).catch(() => []);
    return NextResponse.json({
      vectorEnabled: false,
      reranked: false,
      hits,
      timings: { retrievalMs: Date.now() - t0, rerankMs: 0 },
    });
  }

  const t0 = Date.now();
  const candidates = await queryVector(q, 12).catch(() => [] as VectorHit[]);
  const retrievalMs = Date.now() - t0;

  let hits = candidates.slice(0, 8);
  let rerankMs = 0;
  const doRerank = wantRerank && rerankEnabled();
  if (doRerank) {
    const t1 = Date.now();
    hits = await rerankHits(q, candidates, 8);
    rerankMs = Date.now() - t1;
  }

  return NextResponse.json({
    vectorEnabled: true,
    reranked: doRerank,
    hits,
    timings: { retrievalMs, rerankMs },
  });
}
