/**
 * Evaluation feed for the /evals console (admin-gated).
 *
 *   GET → { evaluations, stats }
 *
 * Stats cover the last 30 days: counts by rating, edit/discard rates, tag
 * frequency, and a per-product breakdown.
 */
import { NextRequest, NextResponse } from "next/server";
import { adminAuthorized } from "@/lib/auth";
import { listEvaluations, type ReplyEvaluation } from "@/lib/evals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function buildStats(evals: ReplyEvaluation[]) {
  const cutoff = Math.floor(Date.now() / 1000) - 30 * 86400;
  const recent = evals.filter((e) => e.at >= cutoff);
  const byRating = { good: 0, partial: 0, bad: 0 };
  const tagCounts: Record<string, number> = {};
  const byProduct: Record<string, { good: number; partial: number; bad: number }> = {};
  for (const e of recent) {
    byRating[e.rating]++;
    for (const t of e.tags) tagCounts[t] = (tagCounts[t] ?? 0) + 1;
    byProduct[e.product] ??= { good: 0, partial: 0, bad: 0 };
    byProduct[e.product][e.rating]++;
  }
  const total = recent.length;
  return {
    windowDays: 30,
    total,
    byRating,
    editRate: total ? byRating.partial / total : 0,
    discardRate: total ? byRating.bad / total : 0,
    tagCounts,
    byProduct,
  };
}

export async function GET(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const evaluations = await listEvaluations();
  return NextResponse.json({ evaluations, stats: buildStats(evaluations) });
}
