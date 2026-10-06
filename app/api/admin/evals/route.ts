/**
 * Evaluation feed for the /evals console (admin-gated).
 *
 *   GET → { evaluations, stats }
 *
 * Stats cover the last 30 days: counts by rating, edit/discard rates, tag
 * frequency, and a per-product breakdown.
 *
 * Draft-decision stats count console decisions only (review). The other two
 * sources are one-sided, so each is reported on its own line:
 *  - `stats.reconciled` — drafts an agent sent from Freshdesk. Only USED drafts
 *    are recorded (unused ones write no evaluation), so folding them in would
 *    peg the discard rate at zero. Adoption rates live on /performance.
 *  - `stats.mined` — mining keeps only the pairs a blind judge scored against
 *    Jetta, so folding it in would peg "sent as-is" at zero and inflate the
 *    discard rate.
 */
import { NextRequest, NextResponse } from "next/server";
import { adminAuthorized } from "@/lib/auth";
import { listEvaluations, type ReplyEvaluation } from "@/lib/evals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Rating/tag/product tallies for one set of evaluations. */
function tally(evals: ReplyEvaluation[]) {
  const byRating = { good: 0, partial: 0, bad: 0 };
  const tagCounts: Record<string, number> = {};
  const byProduct: Record<string, { good: number; partial: number; bad: number }> = {};
  for (const e of evals) {
    byRating[e.rating]++;
    for (const t of e.tags) tagCounts[t] = (tagCounts[t] ?? 0) + 1;
    byProduct[e.product] ??= { good: 0, partial: 0, bad: 0 };
    byProduct[e.product][e.rating]++;
  }
  return { total: evals.length, byRating, tagCounts, byProduct };
}

function buildStats(evals: ReplyEvaluation[]) {
  const cutoff = Math.floor(Date.now() / 1000) - 30 * 86400;
  const recent = evals.filter((e) => e.at >= cutoff);
  const decisions = tally(recent.filter((e) => !e.source || e.source === "review"));
  const reconciled = tally(recent.filter((e) => e.source === "reconcile"));
  const mined = tally(recent.filter((e) => e.source === "mined"));
  const total = decisions.total;
  return {
    windowDays: 30,
    total,
    byRating: decisions.byRating,
    editRate: total ? decisions.byRating.partial / total : 0,
    discardRate: total ? decisions.byRating.bad / total : 0,
    tagCounts: decisions.tagCounts,
    byProduct: decisions.byProduct,
    reconciled,
    mined,
  };
}

export async function GET(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const evaluations = await listEvaluations();
  return NextResponse.json({ evaluations, stats: buildStats(evaluations) });
}
