/**
 * "Learn from human replies" — mine recent human-answered tickets, compare each
 * against Jetta's would-be draft, and record the divergences as evaluations so
 * the existing distiller can turn recurring patterns into candidate learnings.
 *
 *   POST { limit? }  → { sampled, compared, skippedJetta, divergent, recorded }
 *
 * Read-heavy + LLM-heavy (one dry-run agent replay per ticket, plus a classify
 * call per divergence), so limit is capped. Mined evals are tagged source:"mined"
 * and flow through the SAME distill → /evals approval loop as everything else —
 * nothing changes Jetta's behavior until a human approves the learnings.
 */
import { NextRequest, NextResponse } from "next/server";
import { adminAuthorized, adminActor } from "@/lib/auth";
import { config } from "@/lib/config";
import { recordEvaluation } from "@/lib/evals";
import { jettaDraftForTicket, recentResolvedTicketIds, classifyDivergence } from "@/lib/human-compare";
import { replySimilarity, classifyReplySimilarity, normalizeReplyText } from "@/lib/reply-similarity";
import { logOpsEvent } from "@/lib/events";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const actor = adminActor(req) ?? "console";
  const body = (await req.json().catch(() => ({}))) as { limit?: number };
  const limit = Math.min(Math.max(Number(body.limit) || 12, 1), 50);

  // Each ticket is a full dry-run agent replay (~1–2 min), so we can't finish a
  // big batch inside the 300s function budget. Process newest-first until the
  // budget is nearly spent and return partial progress — mined evals persist
  // (idempotent by id) and accumulate across repeated runs / a cron.
  const startedAt = Date.now();
  const TIME_BUDGET_MS = 240_000;

  const ticketIds = await recentResolvedTicketIds(limit);
  const jettaUserId = config.freshdesk.agentId ? Number(config.freshdesk.agentId) : null;

  let compared = 0;
  let skippedJetta = 0;
  let divergent = 0;
  let recorded = 0;
  let timedOut = false;
  const now = Math.floor(Date.now() / 1000);

  for (const ticketId of ticketIds) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      timedOut = true;
      break;
    }
    const cmp = await jettaDraftForTicket(ticketId).catch(() => null);
    if (!cmp || !cmp.humanReply || !cmp.jettaReply) continue;
    // Skip tickets where the "human" reply was actually Jetta's own approved draft.
    if (jettaUserId !== null && cmp.humanReplyUserId === jettaUserId) {
      skippedJetta++;
      continue;
    }
    compared++;

    const score = replySimilarity(normalizeReplyText(cmp.jettaReply), normalizeReplyText(cmp.humanReply));
    const rating = classifyReplySimilarity(score);
    if (rating === "good") continue; // Jetta already matches the human — nothing to learn
    divergent++;

    const tag = await classifyDivergence(cmp.customerMessage, cmp.humanReply, cmp.jettaReply).catch(() => "other" as const);
    await recordEvaluation({
      id: `mined-${ticketId}`,
      ticketId,
      subject: cmp.subject,
      channel: "freshdesk",
      product: cmp.product,
      decidedBy: `mine:${actor}`,
      at: now,
      action: rating === "bad" ? "discard" : "approve",
      rating,
      tags: [tag],
      note: `mined comparison — human reply diverged from Jetta's draft (similarity ${score.toFixed(2)})`,
      suggestedReply: cmp.jettaReply,
      finalBody: cmp.humanReply,
      source: "mined",
    }).catch(() => {});
    recorded++;
  }

  const summary = { sampled: ticketIds.length, compared, skippedJetta, divergent, recorded, timedOut };
  await logOpsEvent({ level: "info", event: "evals.mine_human_replies", source: "console", actor, data: summary });
  return NextResponse.json(summary);
}
