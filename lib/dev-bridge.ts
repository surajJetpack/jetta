/**
 * The dev bridge, monday → Freshdesk: Jetta acts on what developers do on a
 * dev item filed for a ticket.
 *
 * Until this, the board was a one-way street. Jetta filed an item and then only
 * learned what happened to it when the CUSTOMER next wrote — so a developer's
 * "which account is this?" sat unanswered until someone in support happened to
 * open the item, and a shipped fix reached the customer only if they asked.
 *
 * The board webhooks (registered for /activity, lib/activity-push.ts) already
 * deliver every comment and column change. Three of them start a ticket run:
 *
 *   comment     a person writes on the item (not Jetta, not an automation)
 *   needs_info  Dev Status → "Need more info" / "Waiting Customer" / "Missing Info"
 *   finished    Dev Status → a terminal value (devItemInFlight's list)
 *
 * The run is an ordinary ticket run with the event added as the last message,
 * DEV_EVENT_RULES in the prompt and reply_on_dev_item in the toolset. What it
 * may do to the customer is unchanged: replies are held as drafts in draft
 * mode, exactly like a webhook run.
 *
 * Off unless JETTA_DEV_BRIDGE is "shadow" (dry run, logged) or "on".
 */
import { config } from "./config";
import { buildContext, buildMessages } from "./context";
import { buildSystemPrompt } from "./system-prompt";
import { runAgentLoop } from "./agent";
import { recordRun } from "./runlog";
import { createDraftFromRun } from "./drafts";
import { logOpsEvent } from "./events";
import { getActivityState, getMondayUsers } from "./activity-store";
import { isRememberedJettaPost, markEventSeen, rateCount } from "./kv";
import * as monday from "./tools/monday";
import type { MondayWebhookEvent } from "./activity";
import type { DevEvent } from "./types";

/**
 * The progress column, by title. Dev Tasks has a second, support-facing
 * "Status" column ("Missing Info", "Not a Bug") next to "Dev Status"; both say
 * something support has to act on.
 */
const PROGRESS_TITLE = /^(dev status|status)$/i;

/**
 * Runs per item per day. A real conversation is a handful of turns; anything
 * past this is two systems talking to each other, and stopping is the fix.
 */
const MAX_RUNS_PER_ITEM_PER_DAY = 6;

export type DevTrigger =
  | { kind: "comment"; text: string; threadUpdateId?: string; postId?: string }
  | { kind: "needs_info" | "finished"; status: string };

/**
 * Which monday events start a run, and which are noise. Pure.
 *
 * monday's create_update carries `updateId` for a top-level comment, and for a
 * reply both the thread's `updateId` and the reply's own `replyId` (the
 * convention lib/activity.ts reads them by). Jetta answers in the thread.
 */
export function classifyDevEvent(
  e: MondayWebhookEvent,
  devBoards: string[],
  selfId: string | null,
): DevTrigger | { skip: string } {
  const userId = e.userId != null ? String(e.userId) : "";
  if (!userId || userId === "-4") return { skip: "automation" };
  if (!devBoards.includes(String(e.boardId ?? ""))) return { skip: "not a dev board" };
  if (e.pulseId == null) return { skip: "no item" };

  if (e.type === "create_update") {
    const text = (e.textBody ?? "").trim();
    if (!text) return { skip: "empty comment" };
    if (monday.isJettaPost(text)) return { skip: "own post" };
    if (userId === selfId && monday.isJettaContextPost(text)) return { skip: "own post" };
    const thread = e.updateId != null ? String(e.updateId) : undefined;
    const post = e.replyId != null ? String(e.replyId) : thread;
    return { kind: "comment", text, threadUpdateId: thread, postId: post };
  }

  if (e.type === "change_column_value" || e.type === "change_status_column_value" || e.type === "update_column_value") {
    if (e.columnType !== "color" && e.columnType !== "status") return { skip: "not a status column" };
    const title = (e.columnTitle ?? "").replace(/\s*↗️?\s*$/, "").trim();
    if (!PROGRESS_TITLE.test(title)) return { skip: `column "${title}"` };
    const status = ((e.value as { label?: { text?: string } } | null)?.label?.text ?? "").trim();
    if (monday.isNeedsInfoDevStatus(status)) return { kind: "needs_info", status };
    if (monday.isFinishedDevStatus(status)) return { kind: "finished", status };
    return { skip: `status "${status}"` };
  }

  return { skip: `event ${e.type}` };
}

/** The event, as the last message of the run. */
export function devEventMessage(ev: DevEvent): string {
  const head = `[Dev board] Item "${ev.itemName}" — Dev Status: ${ev.devStatus ?? "unknown"}`;
  if (ev.kind === "comment") {
    return `${head}\n${ev.author} commented on the item:\n"""\n${ev.text}\n"""\n\nDecide, by the developer-run rules, what (if anything) to do.`;
  }
  const recent = ev.recent.length
    ? `Latest comments on the item, newest first:\n${ev.recent.map((r) => `- ${r.author} (${r.at}): ${r.text}`).join("\n")}`
    : "There are no comments on the item.";
  const what =
    ev.kind === "needs_info"
      ? "That means a developer is waiting on support. Work out what they need from the comments."
      : "That is a finished status.";
  return `${head}\n${ev.author} set Dev Status to "${ev.devStatus}". ${what}\n\n${recent}\n\nDecide, by the developer-run rules, what (if anything) to do.`;
}

function devBoardIds(): string[] {
  return [config.monday.boardIds.jetpackapps, config.monday.boardIds.getsign].filter((b): b is string => !!b);
}

/**
 * Entry point from the monday webhook. Never throws: the webhook has already
 * been acknowledged, and a failure here must only cost this one run.
 */
export async function handleDevBoardEvent(e: MondayWebhookEvent): Promise<void> {
  if (config.devBridge === "off") return;
  const itemId = e.pulseId != null ? String(e.pulseId) : "";
  try {
    const state = await getActivityState();
    const trigger = classifyDevEvent(e, devBoardIds(), state.mondaySelf?.id ?? null);
    if ("skip" in trigger) return;

    // monday redelivers; one event, one run.
    const eventKey = e.triggerUuid ?? `${itemId}:${trigger.kind === "comment" ? trigger.postId : trigger.status}`;
    if (!(await markEventSeen(`devbridge:${eventKey}`, 24 * 3600))) return;
    if (trigger.kind === "comment" && trigger.postId && (await isRememberedJettaPost(trigger.postId))) return;

    const item = await monday.getDevItemSnapshot(itemId);
    const ticketId = item?.ticketIds[0];
    if (!item || !ticketId) {
      await logOpsEvent({
        level: "info",
        event: "devbridge.skipped_no_ticket",
        source: "webhook",
        data: { itemId, kind: trigger.kind },
      });
      return;
    }

    if ((await rateCount(`devbridge:item:${itemId}`, 24 * 3600)) > MAX_RUNS_PER_ITEM_PER_DAY) {
      await logOpsEvent({
        level: "warn",
        event: "devbridge.rate_limited",
        source: "webhook",
        ticketId,
        data: { itemId, kind: trigger.kind },
      });
      return;
    }

    const ctx = await buildContext(ticketId, "freshdesk");
    if (!ctx.ticket) return;

    const users = await getMondayUsers();
    const recent =
      trigger.kind === "comment"
        ? []
        : ((await monday.getItemUpdates(itemId, 5).catch(() => null))?.updates ?? []).map((u) => ({
            at: u.at,
            author: u.author,
            text: u.text.slice(0, 800),
          }));
    const ev: DevEvent = {
      kind: trigger.kind,
      itemId,
      itemName: item.name,
      itemUrl: item.url,
      devStatus: trigger.kind === "comment" ? item.devStatus : trigger.status,
      author: users.get(String(e.userId)) ?? "A developer",
      text: trigger.kind === "comment" ? trigger.text.slice(0, 3000) : undefined,
      threadUpdateId: trigger.kind === "comment" ? trigger.threadUpdateId : undefined,
      developers: item.developers,
      recent,
    };
    ctx.devEvent = ev;

    // buildMessages ends a thread whose last word was ours with a generic
    // "re-evaluate" nudge; here the developer's event is the reason to act.
    const messages = buildMessages(ctx.ticket);
    const last = messages[messages.length - 1];
    if (last?.role === "user" && String(last.content).startsWith("[system] Re-evaluate")) messages.pop();
    messages.push({ role: "user", content: devEventMessage(ev) });

    const shadow = config.devBridge === "shadow";
    const draftMode = config.replyMode === "draft";
    const started = Date.now();
    const result = await runAgentLoop(
      await buildSystemPrompt(ctx),
      messages,
      ctx,
      shadow ? { dryRun: true } : draftMode ? { holdCustomerWrites: true } : {},
    );
    await recordRun("devboard", ctx, result, Date.now() - started);
    const draft = !shadow && draftMode ? await createDraftFromRun(ctx, result) : null;

    await logOpsEvent({
      level: "info",
      event: shadow ? "devbridge.shadow_run" : "devbridge.run",
      source: "webhook",
      ticketId,
      data: {
        itemId,
        kind: ev.kind,
        devStatus: ev.devStatus,
        author: ev.author,
        toolsUsed: result.toolsUsed,
        drafted: !!draft,
        // What she did (or, in shadow, would have done) outward — the part
        // worth reading before the bridge is switched on.
        actions: result.trace
          .filter((t) => ["reply_on_dev_item", "reply_to_ticket", "add_private_note"].includes(t.tool))
          .map((t) => ({ tool: t.tool, input: t.input })),
      },
    });
  } catch (err) {
    console.error(`dev bridge failed for item ${itemId}:`, err);
    await logOpsEvent({
      level: "error",
      event: "devbridge.failed",
      source: "webhook",
      data: { itemId, type: e.type, error: err instanceof Error ? err.message : String(err) },
    });
  }
}
