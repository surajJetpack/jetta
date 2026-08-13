/**
 * Draft reconciliation cron — reads back from Freshdesk what humans did with
 * Jetta's suggestions.
 *
 * The push equivalent (/api/webhook/agent-reply) depends on a Freshdesk
 * automation rule that was never created, so it fired once in a month while 242
 * drafts went unjudged and the /evals learning loop starved. Polling has no such
 * dependency: if it stops working, the summary event below stops appearing.
 *
 * Cheap by design — one Freshdesk read per pending draft, and pending drafts are
 * only the ones a human hasn't answered yet.
 */
import { NextRequest, NextResponse } from "next/server";
import { listReplyDrafts } from "@/lib/kv";
import { logOpsEvent } from "@/lib/events";
import { reconcileTicketDraft, type ReconcileStatus } from "@/lib/reconcile";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Per-run ceiling — keeps one bad day from spending the whole FD rate budget. */
const MAX_PER_RUN = 40;
/** Spacing between Freshdesk reads. fd() retries 429s, but pacing avoids them. */
const PACE_MS = 400;
/** Give the human a moment to reply before judging them. */
const MIN_AGE_MINUTES = 15;
/**
 * Stop polling a draft nobody ever answered. Without this the oldest unanswerable
 * drafts refill MAX_PER_RUN every hour and newer ones are never reached — 3 of
 * the first 12 backfilled drafts had no agent reply at all. They stay pending and
 * age out with the 30-day draft TTL.
 */
const MAX_AGE_DAYS = 14;

function authorized(req: NextRequest): boolean {
  // Fails CLOSED, unlike the older cron routes: a missing secret must not make
  // this publicly triggerable.
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = Date.now() / 1000;
  const all = await listReplyDrafts();
  const eligible = all.filter(
    (d) =>
      d.state === "pending" &&
      d.channel === "freshdesk" &&
      now - d.createdAt >= MIN_AGE_MINUTES * 60 &&
      now - d.createdAt <= MAX_AGE_DAYS * 86400,
  );
  // Oldest first within the eligible window, so nothing inside it is starved.
  const drafts = eligible.sort((a, b) => a.createdAt - b.createdAt).slice(0, MAX_PER_RUN);

  const counts: Partial<Record<ReconcileStatus, number>> = {};
  const ratings: Record<string, number> = {};

  for (const draft of drafts) {
    const r = await reconcileTicketDraft(draft.ticketId, { source: "cron" });
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    if (r.rating) ratings[r.rating] = (ratings[r.rating] ?? 0) + 1;
    await new Promise((res) => setTimeout(res, PACE_MS));
  }

  // One summary event per run — the heartbeat that proves this is still working.
  await logOpsEvent({
    level: "info",
    event: "cron.reconcile_run",
    source: "cron",
    data: { examined: drafts.length, eligible: eligible.length, ...counts, ratings },
  });

  return NextResponse.json({
    examined: drafts.length,
    eligible: eligible.length,
    backlog: eligible.length - drafts.length,
    counts,
    ratings,
  });
}
