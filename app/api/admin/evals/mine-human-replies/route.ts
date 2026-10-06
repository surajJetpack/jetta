/**
 * "Learn from human replies" — mine recent human-answered tickets, compare each
 * against Jetta's would-be draft, and record the ones where the human did
 * BETTER as evaluations, so the existing distiller can turn recurring patterns
 * into candidate learnings.
 *
 *   POST { limit? }  → { sampled, skippedMined, compared, skippedJetta, divergent,
 *                        jettaHeld, notLearnable, judgeFailed, recorded, timedOut }
 *
 * "Different" is not "worse". Word overlap decides only whether the two replies
 * are the same text; when they are not, the blind judge in lib/judge.ts decides
 * which one served the customer better. Before that step, 30 of 31 mined rows
 * in a month were rated "bad" — including ticket 14433, where Jetta and the
 * human both told the customer to contact monday.com support — and the
 * distiller was told "the human wrote a different reply" every time.
 *
 * Read-heavy + LLM-heavy (one dry-run agent replay per ticket, plus one or two
 * judge calls per divergence), so limit is capped. Mined evals are tagged
 * source:"mined" and flow through the SAME distill → /evals approval loop as
 * everything else — nothing changes Jetta's behavior until a human approves
 * the learnings.
 */
import { NextRequest, NextResponse } from "next/server";
import { adminAuthorized, adminActor } from "@/lib/auth";
import { config } from "@/lib/config";
import { getEvaluation, minedEvalId, recordEvaluation } from "@/lib/evals";
import { jettaDraftForTicket, recentResolvedTicketIds, classifyDivergence } from "@/lib/human-compare";
import { judgeDraftPair } from "@/lib/judge";
import { replySimilarity, classifyReplySimilarity, normalizeReplyText } from "@/lib/reply-similarity";
import { logOpsEvent } from "@/lib/events";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * How many recent tickets to look at to find `limit` unmined ones. The search
 * itself is cheap (it pages the same 300 results regardless); the replay is
 * what costs, and that is only paid for tickets that get past the skip below.
 */
const OVERSAMPLE = 3;
const MAX_CANDIDATES = 150;

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

  const candidates = await recentResolvedTicketIds(Math.min(limit * OVERSAMPLE, MAX_CANDIDATES));
  const jettaUserId = config.freshdesk.agentId ? Number(config.freshdesk.agentId) : null;

  let sampled = 0;
  let skippedMined = 0;
  let compared = 0;
  let skippedJetta = 0;
  let divergent = 0;
  let jettaHeld = 0;
  let notLearnable = 0;
  let judgeFailed = 0;
  let recorded = 0;
  let timedOut = false;
  const now = Math.floor(Date.now() / 1000);

  for (const ticketId of candidates) {
    if (sampled >= limit) break;
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      timedOut = true;
      break;
    }
    // A ticket is mined once. Replaying it again would spend a minute of the
    // budget on evidence we already hold, and re-recording it would drop the
    // `distilled` flag and feed the same ticket to the distiller a second time.
    // Before this check the newest tickets were replayed on every click, so a
    // run that timed out never got past them.
    if (await getEvaluation(minedEvalId(ticketId))) {
      skippedMined++;
      continue;
    }
    sampled++;
    const cmp = await jettaDraftForTicket(ticketId).catch(() => null);
    if (!cmp || !cmp.humanReply || !cmp.jettaReply) continue;
    // Skip tickets where the "human" reply was actually Jetta's own approved draft.
    if (jettaUserId !== null && cmp.humanReplyUserId === jettaUserId) {
      skippedJetta++;
      continue;
    }
    compared++;

    const score = replySimilarity(normalizeReplyText(cmp.jettaReply), normalizeReplyText(cmp.humanReply));
    if (classifyReplySimilarity(score) === "good") continue; // same text — nothing to learn
    divergent++;

    // Different words. Was the human's reply actually better? Blind, with the
    // presentation order alternating so the judge cannot learn a position.
    const judgement = await judgeDraftPair({
      customerMessage: cmp.customerMessage,
      jettaReply: cmp.jettaReply,
      humanReply: cmp.humanReply,
      jettaFirst: divergent % 2 === 1,
    }).catch((e: unknown) => {
      log.warn("evals.mine_judge_failed", { ticketId, error: e instanceof Error ? e.message : String(e) });
      return null;
    });
    // Fail closed: without a verdict there is no evidence the draft fell short,
    // and the old word-overlap "bad" is exactly what this step exists to stop.
    if (!judgement) {
      judgeFailed++;
      continue;
    }
    if (judgement.winner !== "human") {
      jettaHeld++;
      continue;
    }
    // The human knew something internal or had already acted. True, but not a
    // lesson a prompt change could use.
    if (!judgement.learnable) {
      notLearnable++;
      continue;
    }

    const tags = judgement.tags.length
      ? judgement.tags
      : [await classifyDivergence(cmp.customerMessage, cmp.humanReply, cmp.jettaReply).catch(() => "other" as const)];
    await recordEvaluation({
      id: minedEvalId(ticketId),
      ticketId,
      subject: cmp.subject,
      channel: "freshdesk",
      product: cmp.product,
      decidedBy: `mine:${actor}`,
      at: now,
      action: "discard",
      rating: "bad",
      tags,
      note:
        `mined comparison — blind judge preferred the human reply (${judgement.reason}): ` +
        `${judgement.explanation.slice(0, 300)} (word overlap ${score.toFixed(2)})`,
      suggestedReply: cmp.jettaReply,
      finalBody: cmp.humanReply,
      source: "mined",
    }).catch(() => {});
    recorded++;
  }

  const summary = {
    sampled,
    skippedMined,
    compared,
    skippedJetta,
    divergent,
    jettaHeld,
    notLearnable,
    judgeFailed,
    recorded,
    timedOut,
  };
  await logOpsEvent({ level: "info", event: "evals.mine_human_replies", source: "console", actor, data: summary });
  return NextResponse.json(summary);
}
