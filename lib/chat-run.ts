/**
 * The agent turn for a JettaChat conversation.
 *
 * This is the chat counterpart of `processTicket` in the Freshdesk webhook,
 * and it differs in three ways that all follow from the same fact — a person
 * is sitting there waiting, and nothing here is reviewed before they see it:
 *
 *   1. **Debounce.** Visitors send a thought across several messages ("hi" /
 *      "quick question" / the actual question). Wait for the pause, then
 *      answer the whole thing once.
 *   2. **Autonomous.** No draft mode. A reply held for human approval is a
 *      dead conversation, so `holdCustomerWrites` is never set on this path.
 *      The safety model moves from pre-send review to the absolute grounding
 *      rule in the prompt plus after-the-fact review in the console.
 *   3. **Silence is a bug — but not always the same bug.** On a ticket, a run
 *      that produces no reply is invisible and harmless. Here it is a customer
 *      staring at a typing indicator that stops. Every exit path sends
 *      something; `chooseDelivery` decides what, because a turn that asked for
 *      a colleague and then went quiet did what the prompt told it to, and
 *      answering that with the crash apology told a customer the bot had broken
 *      at the moment it had actually worked.
 */
import { getChatSettings } from "./chat-settings";
import { buildContext, buildMessages } from "./context";
import { buildSystemPrompt } from "./system-prompt";
import { runAgentLoop } from "./agent";
import { recordRun } from "./runlog";
import { recordOutcome } from "./kv";
import { logOpsEvent } from "./events";
import * as store from "./chat-store";
import type { ChatConversation } from "./types";
import { toChatText } from "./tools/jettachat";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * What the visitor sees when the run couldn't produce a reply — a crash, a
 * model timeout, or a loop that ended with empty text. Better than silence, and
 * it asks for the one thing that lets a human recover the conversation. Deliberately not a ticket: we may have no email yet, and
 * opening one without an address strands the customer either way.
 */
const FALLBACK_TEXT =
  "Sorry — something went wrong on my end and I couldn't get you an answer just now. " +
  "If you leave your email address here, I'll get this to our team and they'll reply to you directly.";

async function deliverFallback(conversationId: string): Promise<void> {
  await store.appendMessage(conversationId, "agent", FALLBACK_TEXT);
}

/**
 * A run can end with no text and still have done its job.
 *
 * "Silence is a bug" was written for the crash case and then applied to every
 * empty turn, including the two where going quiet is what the prompt ASKS for.
 * Called request_human? She is told to say one thing and stop. So a turn that
 * asked for a colleague and produced no text was being answered with
 * "something went wrong on my end" — the bot telling a customer it had broken
 * at the exact moment it had actually succeeded in fetching them a person.
 *
 * These are not the crash apology. They say the true thing the model didn't.
 */
const HANDOFF_ACK =
  "I've asked the team — if someone's free they'll jump in here. " +
  "If nobody is, I'll pick this back up in a minute.";
const TICKET_ACK =
  "I've passed this to our team — they'll get back to you by email shortly.";
/**
 * The post-ticket sibling of TICKET_ACK. Different words on purpose: the
 * customer already knows a ticket exists, and telling them again that their
 * question "has been passed to the team" reads as the bot having forgotten the
 * last five minutes.
 */
const ADDED_ACK =
  "I've added that to what the team already has — they'll cover it in their reply.";

export type DeliveryKind = "reply" | "handoff_ack" | "ticket_ack" | "added_ack" | "fallback";

/**
 * What the visitor gets, given what the loop produced.
 *
 * Pulled out of runChatTurn as a pure function for one reason: it is the branch
 * that got this wrong in production, and inside the turn it could only be
 * exercised by a live model that had to be coaxed into going quiet. Here it is
 * four assertions in a test that costs nothing — see scripts/chat-contract-test.ts.
 */
export function chooseDelivery(
  text: string,
  toolsUsed: readonly string[],
): { kind: DeliveryKind; text: string } {
  const trimmed = text.trim();
  if (trimmed) return { kind: "reply", text: trimmed };
  // Order matters: a turn that did both asked for a person LAST, and the person
  // is the more immediate promise.
  if (toolsUsed.includes("request_human")) return { kind: "handoff_ack", text: HANDOFF_ACK };
  if (toolsUsed.includes("create_support_ticket")) return { kind: "ticket_ack", text: TICKET_ACK };
  // Below the other two: a turn that opened a ticket AND pushed to one is
  // describing the ticket it just opened, and that is the bigger news.
  if (toolsUsed.includes("add_to_ticket")) return { kind: "added_ack", text: ADDED_ACK };
  return { kind: "fallback", text: FALLBACK_TEXT };
}

/**
 * Run one turn. Safe to call on every visitor message: the debounce + turn
 * check mean only the newest message in a burst actually spends an agent loop.
 */
export async function runChatTurn(conversationId: string, messageId: string): Promise<void> {
  // Set when this turn asked for a person; the handoff timer starts after it.
  let handedOff = false;
  try {
    // 1. Debounce. If a newer message lands while we wait, that message's own
    //    run will cover the full thought and this one exits without spending.
    const settings = await getChatSettings();
    await sleep(Math.max(0, settings.debounceSeconds) * 1000);
    if (!(await store.isLatestTurn(conversationId, messageId))) {
      await logOpsEvent({
        level: "info",
        event: "chat.turn_superseded",
        source: "jettachat",
        ticketId: conversationId,
      });
      return;
    }

    // 2. Stand down if a person owns this conversation.
    //
    // Two voices answering one visitor is the failure that makes handoff feel
    // broken, so Jetta goes completely silent from the moment a human is asked
    // for — not just once one arrives. The exception is nobody arriving: after
    // HANDOFF_TIMEOUT_MS the conversation reverts to her so the visitor gets an
    // answer and a ticket instead of a silence that never ends.
    const current = await store.getConversation(conversationId);
    if (current?.status === "human") return;
    if (current?.status === "waiting_human") {
      const waited = Date.now() - (current.humanRequestedAt ?? 0);
      if (waited < settings.handoffTimeoutMinutes * 60_000) return;
      // Back to whichever state she was in before the ask. A conversation that
      // already had a ticket must not be demoted to "open" here: the console
      // would list it as unhandled and /today would resurrect a row that is a
      // duplicate of the Freshdesk ticket.
      //
      // endHandoff is a compare-and-set: the handoff timer or the cron backstop
      // may have ended it a moment ago, and the visitor must hear "nobody's
      // free" once. Losing it means one of those is already answering.
      if (!(await store.endHandoff(conversationId, { touch: true }))) return;
      await announceHandoffEnded(conversationId, waited, "visitor_message");
    }

    await store.markRunActive(conversationId);

    const ctx = await buildContext(conversationId, "jettachat");
    if (!ctx.ticket) {
      await logOpsEvent({
        level: "warn",
        event: "chat.conversation_missing",
        source: "jettachat",
        ticketId: conversationId,
      });
      return;
    }

    // Note: the product rollout filter (JETTA_PRODUCTS) is deliberately NOT
    // applied here. On email it means "don't draft" and a human still sees the
    // ticket; on chat it would mean ignoring someone mid-conversation. The
    // rollout gate for this channel is JETTACHAT_LIVE, which stops traffic at
    // the door rather than halfway through a conversation.

    /*
     * Stamp which app this conversation is about, once we know.
     *
     * `ctx.app` is the same precedence the rest of the system reports on —
     * the embed's `data-app` when the snippet set one, triage's reading of the
     * conversation when it did not — and it was being computed on every turn
     * and thrown away, leaving the console with an `app` field only the GetSign
     * and monday embeds ever filled in. Fire-and-forget: it is a reporting
     * field, and the visitor is waiting on the answer, not on this.
     *
     * `setConversationApp` rather than a patch, because a label is not
     * activity — see the note on it in lib/chat-store.ts.
     */
    if (ctx.app && ctx.app !== "unknown" && ctx.app !== current?.app) {
      void store.setConversationApp(conversationId, ctx.app);
    }

    const messages = buildMessages(ctx.ticket, "jettachat");
    /*
     * While the visitor is anonymous, the system-prompt rule alone is not
     * enough: judged prod transcripts show the model asking on turn one and
     * dropping the ask the moment the visitor ignores it — pricing question,
     * full answer, no ask, conversation stays anonymous forever. A note pinned
     * to the LATEST visitor message sits where the model actually looks before
     * writing. Self-removing by construction: the turn identity is saved,
     * needsIdentity is false and no note is built.
     */
    if (ctx.chat?.needsIdentity) {
      const last = [...messages].reverse().find((m) => m.role === "user");
      if (last && typeof last.content === "string") {
        last.content +=
          "\n\n[Note from the system, NOT the visitor: they are still anonymous. However you answer, this reply must also ask for their name and email (briefly, varied wording) — and keep the substantive help short until you have both.]";
      }
    }
    const system = await buildSystemPrompt(ctx);
    const started = Date.now();

    // Autonomous by necessity, and pinned to the standard tier: no human reads
    // this before the customer does, so it is not a place to save on model.
    const result = await runAgentLoop(system, messages, ctx);
    await recordRun("jettachat", ctx, result, Date.now() - started);

    const ticketed = result.toolsUsed.includes("create_support_ticket");
    handedOff = result.toolsUsed.includes("request_human");

    // Answering ON TOP of an existing ticket is the newest mode on this
    // channel and the one most likely to go wrong in a way nobody notices —
    // she can only contradict a colleague here. Counted while it beds in.
    if (ctx.chat?.ticketId) {
      await logOpsEvent({
        level: "info",
        event: "chat.post_ticket_turn",
        source: "jettachat",
        ticketId: conversationId,
        data: {
          freshdeskTicket: ctx.chat.ticketId,
          toolsUsed: result.toolsUsed,
          pushedToTicket: result.toolsUsed.includes("add_to_ticket"),
        },
      });
    }

    // Delivery. On this channel the agent has no reply tool — its final text
    // is the message, so sending it is our job rather than the model's. An
    // empty final text is the only way a turn can now produce nothing, and
    // that means the loop genuinely failed rather than forgot.
    const delivery = chooseDelivery(result.text, result.toolsUsed);

    if (delivery.kind !== "reply" && delivery.kind !== "fallback") {
      // The run succeeded and went quiet. Standing in for her is not a failure,
      // but it IS a prompt-adherence miss worth counting — she is told to send
      // exactly one message before stopping.
      await logOpsEvent({
        level: "info",
        event: "chat.quiet_after_handoff",
        source: "jettachat",
        ticketId: conversationId,
        data: { toolsUsed: result.toolsUsed, stoodIn: delivery.kind },
      });
    } else if (delivery.kind === "fallback") {
      // Nothing was said and nothing was handed on: the loop genuinely failed.
      await logOpsEvent({
        level: "warn",
        event: "chat.no_reply_sent",
        source: "jettachat",
        ticketId: conversationId,
        data: { toolsUsed: result.toolsUsed },
      });
    }

    await store.appendMessage(
      conversationId,
      "agent",
      delivery.kind === "reply" ? toChatText(delivery.text) : delivery.text,
    );

    // For the outcome record, "replied" has always meant a real message reached
    // the customer — the crash apology is the one case where it did not. A
    // stand-in ack counts: the visitor was told what happened and what next.
    const replied = delivery.kind !== "fallback";

    await recordOutcome({
      ticketId: conversationId,
      subject: ctx.ticket.subject,
      at: Math.floor(Date.now() / 1000),
      channel: "jettachat",
      product: ctx.product,
      app: ctx.app,
      topic: ctx.topic,
      model: result.model,
      toolsUsed: result.toolsUsed,
      replied,
      // Same defence in depth as the Freshdesk webhook: only count a
      // resolution if a reply actually went out. The model logs
      // "resolution_sent" in its note as a matter of habit, and it does that
      // even on turns where it forgot to send anything.
      //
      // …and never on a conversation whose answer is coming from a ticket. A
      // visitor who says "fine, I'll wait for the email" is a perfectly good
      // reason for her to mark the CHAT resolved, but the problem is not
      // solved and a colleague still has to solve it. Counting it would credit
      // her with resolutions the team is about to work.
      resolutionSent: result.resolutionSent && replied && !ctx.chat?.ticketId && !ticketed,
      escalated: result.toolsUsed.includes("send_escalation") || ticketed,
      kind: "handled",
    }).catch((e) => console.warn("recordOutcome failed:", e));
  } catch (err) {
    console.error(`Chat turn failed for conversation ${conversationId}:`, err);
    await logOpsEvent({
      level: "error",
      event: "chat.failed",
      source: "jettachat",
      ticketId: conversationId,
      data: {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
    });
    // The visitor is still waiting — never leave the widget hanging.
    await deliverFallback(conversationId).catch(() => {});
  } finally {
    await store.clearRunActive(conversationId).catch(() => {});
  }
  if (handedOff) await watchHandoff(conversationId).catch(() => {});
}

/** The visitor-facing half of ending a handoff: the apology and the event. */
async function announceHandoffEnded(conversationId: string, waitedMs: number, by: "visitor_message" | "timer" | "cron") {
  await store.appendMessage(
    conversationId,
    "agent",
    "Sorry — nobody's free right now. Let me take this so you're not left waiting.",
  );
  await logOpsEvent({
    level: "info",
    event: "chat.handoff_timed_out",
    source: "jettachat",
    ticketId: conversationId,
    data: { waitedMs, by },
  });
}

/**
 * Past this, a handoff is ended quietly instead of with an apology and a turn.
 * "Sorry — nobody's free right now" is false the next morning, and the visitor
 * is long gone; the conversation goes back under "With Jetta", where it shows
 * as hers to answer, rather than pinned under "Needs a person" forever.
 */
export const HANDOFF_STALE_MS = 2 * 3_600_000;

/** How long after the visitor's last message a run for it may still be pending. */
const IN_FLIGHT_MS = 45_000;

export type HandoffPickup = "not_waiting" | "wait" | "in_flight" | "pick_up" | "stale";

/**
 * What to do about a conversation waiting for a person. Pure.
 *
 * The timeout used to be checked ONLY inside runChatTurn — that is, only when
 * the visitor typed again. A visitor who did what the handoff message implies
 * and waited quietly was never picked up: four handoffs from 2026-09-22 to
 * 2026-10-05, nobody joined any of them, and three sat in silence until a
 * colleague resolved them the next day (one is still waiting).
 *
 * `in_flight`: the visitor wrote moments ago, so their own run may be in its
 * debounce — it will check the timeout itself, and two runs answering one
 * message is the failure this whole file guards against.
 */
export function handoffPickupAction(
  conv: Pick<ChatConversation, "status" | "humanRequestedAt" | "messages">,
  now: number,
  timeoutMinutes: number,
): HandoffPickup {
  if (conv.status !== "waiting_human") return "not_waiting";
  const waited = now - (conv.humanRequestedAt ?? 0);
  if (waited < Math.max(1, timeoutMinutes) * 60_000) return "wait";
  if (waited >= HANDOFF_STALE_MS) return "stale";
  const lastVisitor = [...conv.messages].reverse().find((m) => m.author === "visitor" && !m.system);
  if (lastVisitor && now - Date.parse(lastVisitor.createdAt) < IN_FLIGHT_MS) return "in_flight";
  return "pick_up";
}

/**
 * Keep the promise in HANDOFF_ACK — "if nobody is, I'll pick this back up in
 * a minute" — for a visitor who says nothing more. Called by the handoff timer
 * and by the chat cron as a backstop. Returns what it did.
 */
export async function pickUpHandoff(conversationId: string, by: "timer" | "cron"): Promise<HandoffPickup | "picked_up" | "expired" | "lost_race"> {
  const [conv, settings] = await Promise.all([store.getConversation(conversationId), getChatSettings()]);
  if (!conv) return "not_waiting";
  const action = handoffPickupAction(conv, Date.now(), settings.handoffTimeoutMinutes);
  const waited = Date.now() - (conv.humanRequestedAt ?? 0);

  if (action === "stale") {
    if (!(await store.endHandoff(conversationId, { touch: false }))) return "lost_race";
    await logOpsEvent({
      level: "warn",
      event: "chat.handoff_expired_stale",
      source: "jettachat",
      ticketId: conversationId,
      data: { waitedMs: waited, by },
    });
    return "expired";
  }
  if (action !== "pick_up" || (await store.isRunActive(conversationId))) return action;

  const lastVisitor = [...conv.messages].reverse().find((m) => m.author === "visitor" && !m.system);
  if (!lastVisitor) return "not_waiting";
  if (!(await store.endHandoff(conversationId, { touch: true }))) return "lost_race";
  await announceHandoffEnded(conversationId, waited, by);
  // Answer as if the visitor had just written: same debounce and turn check,
  // so a message they send meanwhile replaces this run rather than doubling it.
  await store.setPendingTurn(conversationId, lastVisitor.id);
  await runChatTurn(conversationId, lastVisitor.id);
  return "picked_up";
}

/**
 * The handoff timer. Runs in the same function invocation as the turn that
 * asked for a person (the message route's `after`, maxDuration 300), so it
 * only covers timeouts that fit; longer ones are the cron's, every 5 minutes.
 */
const TIMER_MAX_MS = 150_000;

async function watchHandoff(conversationId: string): Promise<void> {
  const settings = await getChatSettings();
  const timeoutMs = Math.max(1, settings.handoffTimeoutMinutes) * 60_000;
  if (timeoutMs > TIMER_MAX_MS) return;
  const conv = await store.getConversation(conversationId);
  if (conv?.status !== "waiting_human") return;
  await sleep(Math.max(0, (conv.humanRequestedAt ?? Date.now()) + timeoutMs - Date.now()) + 2_000);
  // A visitor message right at the deadline is the one case this defers on;
  // try once more after it has had time to run.
  if ((await pickUpHandoff(conversationId, "timer")) === "in_flight") {
    await sleep(IN_FLIGHT_MS);
    await pickUpHandoff(conversationId, "timer");
  }
}
