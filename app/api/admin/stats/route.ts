/**
 * Phase 0/3 visibility: outcome metrics + the approved Knowledge-Loop articles.
 * Read-only. Seeds the gap-analytics view in the ops console.
 */
import { NextResponse } from "next/server";
import { getOutcomes, listApprovedArticles } from "@/lib/kv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const outcomes = await getOutcomes(500);
  const total = outcomes.length;
  const escalated = outcomes.filter((o) => o.escalated).length;
  const resolved = outcomes.filter((o) => o.resolutionSent).length;
  const reopened = outcomes.filter((o) => o.kind === "reopened").length;
  const closed = outcomes.filter((o) => o.kind === "closed").length;
  const approved = await listApprovedArticles();

  return NextResponse.json({
    outcomes: {
      total,
      resolved,
      escalated,
      reopened,
      closed,
      // Deflection = share of runs that did NOT need a human escalation.
      deflectionRate: total ? Number((1 - escalated / total).toFixed(2)) : null,
    },
    approvedArticles: approved.map((a) => ({ title: a.title, approvedBy: a.approvedBy, at: a.at })),
    recent: outcomes.slice(0, 20),
  });
}
