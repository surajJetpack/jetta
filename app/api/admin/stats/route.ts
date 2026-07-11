/**
 * Phase 3 gap analytics: outcome metrics + the knowledge gaps they reveal +
 * the approved Knowledge-Loop articles. Read-only; powers the Analytics panel.
 */
import { NextRequest, NextResponse } from "next/server";
import { getOutcomes, listReplyDrafts, type OutcomeEvent, type ReplyDraft } from "@/lib/kv";
import { listArticles } from "@/lib/kb-store";
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

/**
 * Per-model quality: how humans treated each model's drafts (approve/edit/
 * discard) plus run-level outcome rates. This is the evidence base for
 * enabling tiered agent routing (JETTA_TIERED_AGENT).
 */
function modelStats(drafts: ReplyDraft[], outcomes: OutcomeEvent[]) {
  const by = new Map<
    string,
    { drafts: number; approved: number; edited: number; discarded: number; runs: number; escalated: number; reopened: number }
  >();
  const bucket = (model: string | undefined) => {
    const key = model ?? "unknown";
    let b = by.get(key);
    if (!b) {
      b = { drafts: 0, approved: 0, edited: 0, discarded: 0, runs: 0, escalated: 0, reopened: 0 };
      by.set(key, b);
    }
    return b;
  };
  for (const d of drafts) {
    if (d.state === "superseded") continue; // never reviewed — no quality signal
    const b = bucket(d.model);
    b.drafts++;
    if (d.state === "approved") {
      b.approved++;
      if (d.editedBody) b.edited++;
    } else if (d.state === "discarded") {
      b.discarded++;
    }
  }
  for (const o of outcomes) {
    const b = bucket(o.model);
    b.runs++;
    if (o.escalated) b.escalated++;
    if (o.kind === "reopened") b.reopened++;
  }
  return [...by.entries()]
    .map(([model, b]) => {
      const decided = b.approved + b.discarded;
      return {
        model,
        ...b,
        approvalRate: decided ? Number((b.approved / decided).toFixed(2)) : null,
        editRate: b.approved ? Number((b.edited / b.approved).toFixed(2)) : null,
      };
    })
    .sort((a, b) => b.runs - a.runs);
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
  const [outcomes, replyDrafts] = await Promise.all([getOutcomes(500), listReplyDrafts()]);
  const total = outcomes.length;
  const escalated = outcomes.filter((o) => o.escalated).length;
  const resolved = outcomes.filter((o) => o.resolutionSent).length;
  const reopened = outcomes.filter((o) => o.kind === "reopened").length;
  const closed = outcomes.filter((o) => o.kind === "closed").length;

  const gaps = gapList(outcomes);
  const gapKeywords = topKeywords(gaps.map((g) => g.subject));

  const toolUsage: Record<string, number> = {};
  for (const o of outcomes) for (const t of o.toolsUsed) toolUsage[t] = (toolUsage[t] ?? 0) + 1;

  // "Approved" = published articles the team added (not the seeded corpus).
  const approved = (await listArticles({ state: "published", limit: 500 })).filter(
    (a) => a.origin !== "seed-getsign",
  );

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
    approvedArticles: approved.map((a) => ({ title: a.title, approvedBy: a.createdBy, at: a.updatedAt })),
    models: modelStats(replyDrafts, outcomes),
    recent: outcomes.slice(0, 25),
  });
}
