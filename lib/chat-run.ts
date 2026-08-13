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
 *   3. **Silence is a bug.** On a ticket, a run that produces no reply is
 *      invisible and harmless. Here it is a customer staring at a typing
 *      indicator that stops. Every exit path either sends something or opens
 *      a ticket — see `deliverFallback`.
 */
import { config } from "./config";
import { buildContext, buildMessages } from "./context";
import { buildSystemPrompt } from "./system-prompt";
import { runAgentLoop } from "./agent";
import { recordRun } from "./runlog";
import { recordOutcome } from "./kv";
import { logOpsEvent } from "./events";
import * as store from "./chat-store";
import * as freshdesk from "./tools/freshdesk";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * What the visitor sees when the run couldn't produce a reply — a crash, a
 * model timeout, or a loop that ended without calling reply_to_ticket. Better
 * than silence, and it asks for the one thing that lets a human recover the
 * conversation. Deliberately not a ticket: we may have no email yet, and
 * opening one without an address strands the customer either way.
 */
const FALLBACK_TEXT =
  "Sorry — something went wrong on my end and I couldn't get you an answer just now. " +
  "If you leave your email address here, I'll get this to our team and they'll reply to you directly.";

async function deliverFallback(conversationId: string): Promise<void> {
  await store.appendMessage(conversationId, "agent", FALLBACK_TEXT);
}

/**
 * Run one turn. Safe to call on every visitor message: the debounce + turn
 * check mean only the newest message in a burst actually spends an agent loop.
 */
export async function runChatTurn(conversationId: string, messageId: string): Promise<void> {
  try {
    // 1. Debounce. If a newer message lands while we wait, that message's own
    //    run will cover the full thought and this one exits without spending.
    await sleep(Math.max(0, config.jettachat.debounceSeconds) * 1000);
    if (!(await store.isLatestTurn(conversationId, messageId))) {
      await logOpsEvent({
        level: "info",
        event: "chat.turn_superseded",
        source: "jettachat",
        ticketId: conversationId,
      });
      return;
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

    const messages = buildMessages(ctx.ticket, "jettachat");
    const system = await buildSystemPrompt(ctx);
    const started = Date.now();

    // Autonomous by necessity, and pinned to the standard tier: no human reads
    // this before the customer does, so it is not a place to save on model.
    const result = await runAgentLoop(system, messages, ctx);
    await recordRun("jettachat", ctx, result, Date.now() - started);

    const replied = result.toolsUsed.includes("reply_to_ticket");
    const ticketed = result.toolsUsed.includes("create_support_ticket");

    // Safety net: the loop finished without sending anything. The model
    // sometimes ends a turn with plain text instead of a tool call, and on
    // this channel that text goes nowhere.
    if (!replied) {
      await logOpsEvent({
        level: "warn",
        event: "chat.no_reply_sent",
        source: "jettachat",
        ticketId: conversationId,
        data: { toolsUsed: result.toolsUsed, text: result.text.slice(0, 500) },
      });
      // If the model produced usable text, send that rather than the apology —
      // it is the answer it meant to give, just delivered the wrong way.
      if (result.text.trim()) {
        await store.appendMessage(conversationId, "agent", freshdesk.stripHtml(result.text).trim());
      } else {
        await deliverFallback(conversationId);
      }
    }

    await recordOutcome({
      ticketId: conversationId,
      subject: ctx.ticket.subject,
      at: Math.floor(Date.now() / 1000),
      channel: "jettachat",
      product: ctx.product,
      model: result.model,
      toolsUsed: result.toolsUsed,
      replied,
      resolutionSent: result.resolutionSent,
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
}
