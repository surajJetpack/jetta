/**
 * Phase 3 gap analytics: outcome metrics + the knowledge gaps they reveal +
 * the approved Knowledge-Loop articles. Read-only; powers the Analytics panel.
 */
import { NextRequest, NextResponse } from "next/server";
import { getOutcomes, listApprovedArticles, type OutcomeEvent } from "@/lib/kv";
import { config } from "@/lib/config";
import { adminAuthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STOPWORDS = new Set([
  "the", "and", "for", "with", "not", "are", "was", "has", "have", "this", "that", "from",
  "your", "you", "our", "get", "getsign", "monday", "com", "issue", "help", "able", "via",
  "conversation", "request", "reg", "new", "test",
]);

function topKeywords(subjects: string[], n = 8): { term: string; count: number }[] {
  const freq = new Map<string, number>();
  for (const s of subjects) {
    for (const w of s.toLowerCase().split(/[^a-z0-9]+/)) {
      if (w.length > 3 && !STOPWORDS.has(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

function gapList(outcomes: OutcomeEvent[]) {
  // De-dupe by ticket; keep most recent. These are the tickets Jetta couldn't
  // close herself — the prioritised "document these next" list.
  const seen = new Set<string>();
  const out: { ticketId: string; subject: string; reason: string; at: number; url: string }[] = [];
  for (const o of outcomes) {
    if (!o.escalated && o.kind !== "reopened") continue;
    if (seen.has(o.ticketId)) continue;
    seen.add(o.ticketId);
    out.push({
      ticketId: o.ticketId,
      subject: o.subject ?? "(no subject)",
      reason: o.kind === "reopened" ? "reopened" : "escalated",
      at: o.at,
      url: `https://${config.freshdesk.domain ?? "jetpackwork.freshdesk.com"}/a/tickets/${o.ticketId}`,
    });
  }
  return out;
}

export async function GET(req: NextRequest) {
  if (!adminAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const outcomes = await getOutcomes(500);
  const total = outcomes.length;
  const escalated = outcomes.filter((o) => o.escalated).length;
  const resolved = outcomes.filter((o) => o.resolutionSent).length;
  const reopened = outcomes.filter((o) => o.kind === "reopened").length;
  const closed = outcomes.filter((o) => o.kind === "closed").length;

  const gaps = gapList(outcomes);
  const gapKeywords = topKeywords(gaps.map((g) => g.subject));

  const toolUsage: Record<string, number> = {};
  for (const o of outcomes) for (const t of o.toolsUsed) toolUsage[t] = (toolUsage[t] ?? 0) + 1;

  const approved = await listApprovedArticles();

  return NextResponse.json({
    outcomes: {
      total,
      resolved,
      escalated,
      reopened,
      closed,
      deflectionRate: total ? Number((1 - escalated / total).toFixed(2)) : null,
    },
    gaps,
    gapKeywords,
    toolUsage: Object.entries(toolUsage)
      .map(([tool, count]) => ({ tool, count }))
      .sort((a, b) => b.count - a.count),
    approvedArticles: approved
      .map((a) => ({ title: a.title, approvedBy: a.approvedBy, at: a.at }))
      .reverse(),
    recent: outcomes.slice(0, 25),
  });
}
