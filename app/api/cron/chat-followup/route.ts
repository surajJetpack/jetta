/**
 * Chat follow-up sweep — the ending for a conversation the visitor walked away
 * from.
 *
 * The Freshdesk channel has had this for months (/api/cron/followup: no reply
 * since the resolution → send a closing message → close the ticket). This is
 * the same job on a chat clock, where "gone quiet" is measured in minutes
 * rather than a day, and where the decision of what to say is hers.
 *
 * It needs no push plumbing: the widget's stream (app/api/chat/stream) is a
 * tailer of the conversation document, so a message appended here reaches the
 * visitor exactly as one of Jetta's own does — and if their tab is closed, the
 * loader's unread badge survives page navigation and carries it to their next
 * page view. That badge is the whole reason a fifteen-minute nudge is worth
 * sending on a channel people leave.
 *
 * Disarmed by default. `?dry=1` reports what it WOULD do and writes nothing —
 * usable while disarmed, which is the point: read the decisions against real
 * conversations before letting it speak to anyone.
 */
import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { getChatSettings } from "@/lib/chat-settings";
import * as store from "@/lib/chat-store";
import {
  chatFollowUpAction,
  judgeChatFollowUp,
  FOLLOW_UP_FALLBACK,
  type FollowUpDue,
  type FollowUpJudgement,
} from "@/lib/chat-followup";
import { toChatText } from "@/lib/tools/jettachat";
import { recordOutcome } from "@/lib/kv";
import { modelLabel } from "@/lib/llm";
import { logOpsEvent } from "@/lib/events";
import type { ChatConversation } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Per-run ceiling on conversations ACTED on, in the spirit of kb-sync's mass
 * guards: whatever goes wrong upstream, at most this many customers hear from
 * her in one sweep, and the overflow is logged rather than sent. At ~10 chats a
 * day this is many times a normal run.
 */
const MAX_PER_RUN = 10;
/** Candidates read per run. Bounded so a large store can't turn this into a scan. */
const CANDIDATE_LIMIT = 200;
/** Spacing between conversations — each nudge is a model call. */
const PACE_MS = 400;

function authorized(req: NextRequest): boolean {
  // Fails CLOSED, like /api/cron/reconcile-drafts: a route that writes to
  // customers must not become publicly triggerable by an unset variable.
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

const hours = (ms: number) => Math.round((ms / 3_600_000) * 10) / 10;

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const dry = req.nextUrl.searchParams.get("dry") === "1";

  const settings = await getChatSettings();
  // Env is the master arm; the console setting can switch it off but never on.
  const armed = config.jettachat.followUp && settings.followUpEnabled;
  if (!armed && !dry) {
    return NextResponse.json({
      status: "disarmed",
      env: config.jettachat.followUp,
      setting: settings.followUpEnabled,
    });
  }

  const now = Date.now();
  /*
   * Candidates by index score, which is `lastActivityAt`.
   *
   * Anything with newer activity than the nudge threshold cannot be due:
   * activity is at or after the visitor's last message, so an activity gap
   * under the threshold means the visitor gap is too. A conversation she
   * already nudged still shows up here on its way to the 24-hour resolve — her
   * nudge moved the activity clock, not the visitor's.
   */
  const cutoff = now - Math.max(1, settings.followUpMinutes) * 60_000;
  const candidates = await store.listIdleSince(cutoff, CANDIDATE_LIMIT);

  const skips: Record<string, number> = {};
  const due: { conv: ChatConversation; action: FollowUpDue }[] = [];
  for (const conv of candidates) {
    const action = chatFollowUpAction(conv, now, settings);
    if (action.kind === "skip") {
      skips[action.reason] = (skips[action.reason] ?? 0) + 1;
      continue;
    }
    due.push({ conv, action });
  }
  // Longest-silent first, so a capped run works the conversations that have
  // been waiting rather than an arbitrary slice of them.
  due.sort((a, b) => b.action.silentMs - a.action.silentMs);
  const batch = due.slice(0, MAX_PER_RUN);
  const heldBack = due.length - batch.length;

  const handled: {
    id: string;
    action: string;
    reason?: string;
    silentHours: number;
    judgement?: FollowUpJudgement["action"];
  }[] = [];

  for (const { conv, action } of batch) {
    const silentHours = hours(action.silentMs);
    try {
      if (dry) {
        handled.push({ id: conv.id, action: `[dry] ${action.kind}`, reason: "reason" in action ? action.reason : undefined, silentHours });
        continue;
      }

      // Mid-answer. Rare on a conversation this idle, but a run in flight is
      // about to append a message and change what the right decision is.
      if (await store.isRunActive(conv.id)) {
        skips.mid_answer = (skips.mid_answer ?? 0) + 1;
        continue;
      }

      if (action.kind === "resolve") {
        await store.resolveConversation(conv.id, "jetta");
        await noteResolved(conv, action.reason, silentHours);
        handled.push({ id: conv.id, action: "resolved", reason: action.reason, silentHours });
        continue;
      }

      // ── nudge ──
      const lastId = conv.messages[conv.messages.length - 1]?.id;
      let judgement: FollowUpJudgement;
      try {
        judgement = await judgeChatFollowUp(conv);
      } catch (err) {
        // A model that cannot be reached must not silence her — the fallback
        // line is safe on any transcript that reaches this branch.
        judgement = {
          action: "follow_up",
          message: FOLLOW_UP_FALLBACK,
          reason: `judgement failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      /*
       * The visitor may have typed while the model was thinking.
       *
       * Same guard as `isLatestTurn` around an agent turn, in a different
       * shape: re-read and abort if the transcript moved. Deliberately WITHOUT
       * stamping the judgement — they are back and being answered normally, and
       * if they go quiet again the conversation deserves a fresh look rather
       * than a decision taken about an older version of it.
       */
      const fresh = await store.getConversation(conv.id);
      const moved = !fresh || fresh.messages[fresh.messages.length - 1]?.id !== lastId;
      if (moved || chatFollowUpAction(fresh!, Date.now(), settings).kind !== "nudge") {
        skips.overtaken = (skips.overtaken ?? 0) + 1;
        continue;
      }

      if (judgement.action === "follow_up") {
        const text = toChatText(judgement.message?.trim() || FOLLOW_UP_FALLBACK);
        // A normal agent message, NOT system: true. The widget's unread badge
        // counts non-system agent messages, and the badge is how this reaches
        // someone who closed the tab.
        await store.appendMessage(conv.id, "agent", text);
        await store.markFollowUpJudged(conv.id);
        await logOpsEvent({
          level: "info",
          event: "chat.followup_sent",
          source: "cron",
          ticketId: conv.id,
          data: { silentHours, reason: judgement.reason, chars: text.length },
        });
      } else if (judgement.action === "resolve") {
        // The half a fixed template cannot do: she read "perfect, thanks" and
        // there is nothing to chase.
        await store.resolveConversation(conv.id, "jetta");
        await store.markFollowUpJudged(conv.id);
        await noteResolved(conv, "judged", silentHours, judgement.reason);
      } else {
        // "wait" — nothing to say and nothing to close. Stamped anyway, so the
        // conversation costs exactly one judgement and rides the auto-resolve
        // backstop from here.
        await store.markFollowUpJudged(conv.id);
        await logOpsEvent({
          level: "info",
          event: "chat.followup_held",
          source: "cron",
          ticketId: conv.id,
          data: { silentHours, reason: judgement.reason },
        });
      }
      handled.push({ id: conv.id, action: judgement.action, silentHours, judgement: judgement.action });
    } catch (err) {
      handled.push({ id: conv.id, action: "error", reason: err instanceof Error ? err.message : String(err), silentHours });
      await logOpsEvent({
        level: "error",
        event: "chat.followup_failed",
        source: "cron",
        ticketId: conv.id,
        data: { error: err instanceof Error ? err.message : String(err) },
      });
    }
    await new Promise((res) => setTimeout(res, PACE_MS));
  }

  // One summary per run — the heartbeat that shows this is still working on a
  // channel quiet enough that "did nothing" is the normal answer.
  if (!dry && (batch.length || heldBack)) {
    await logOpsEvent({
      level: handled.some((h) => h.action === "error") ? "warn" : "info",
      event: "cron.chat_followup_run",
      source: "cron",
      data: { candidates: candidates.length, due: due.length, heldBack, skips, handled },
    });
  }

  return NextResponse.json({
    status: "ok",
    dry,
    armed,
    thresholds: { followUpMinutes: settings.followUpMinutes, autoResolveHours: settings.autoResolveHours },
    candidates: candidates.length,
    due: due.length,
    heldBack,
    skips,
    handled,
  });
}

/**
 * Count an auto-resolve as an outcome, matching what the Freshdesk follow-up
 * cron records when it closes on silence.
 *
 * `resolutionSent: false` deliberately: she is closing a conversation nobody
 * came back to, not landing a fix. Crediting a resolution here would inflate
 * the one number the channel is judged on — and on a ticketed conversation it
 * would credit her with work a colleague is about to do by email.
 */
async function noteResolved(
  conv: ChatConversation,
  reason: string,
  silentHours: number,
  detail?: string,
): Promise<void> {
  await recordOutcome({
    ticketId: conv.id,
    at: Math.floor(Date.now() / 1000),
    channel: "jettachat",
    product: "unknown",
    app: conv.app,
    model: modelLabel(),
    toolsUsed: reason === "judged" ? ["close_ticket"] : [],
    replied: false,
    resolutionSent: false,
    escalated: false,
    kind: "closed",
  }).catch(() => {});
  await logOpsEvent({
    level: "info",
    event: "chat.auto_resolved",
    source: "cron",
    ticketId: conv.id,
    data: { reason, silentHours, freshdeskTicket: conv.ticketId, detail },
  });
}
