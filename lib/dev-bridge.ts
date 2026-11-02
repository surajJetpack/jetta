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
import {
  getPendingReplyDraftForTicket,
  isRememberedJettaPost,
  kvDel,
  kvGet,
  kvSet,
  kvSetNx,
  markEventSeen,
  rateCount,
} from "./kv";
import * as monday from "./tools/monday";
import { askForKb, draftFromItem, handleKbAnswer, pendingKbAsk, shouldAskForKb } from "./dev-kb";
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

/**
 * Who a comment @mentions, by monday name, leaving out Jetta's own account
 * (her token is Suraj's: "@Suraj Malla" is someone talking to her) and the
 * author. Pure. Longest names first, so "@Shreya Shrestha" is never read as
 * a shorter "@Shreya".
 */
export function addressedNames(
  text: string,
  users: Map<string, string>,
  selfId: string | null,
  authorId?: string,
): string[] {
  const lower = text.toLowerCase();
  const found: string[] = [];
  const taken: [number, number][] = [];
  const people = [...users.entries()].filter(([, n]) => n.trim().length > 1).sort((a, b) => b[1].length - a[1].length);
  for (const [id, name] of people) {
    const needle = `@${name.toLowerCase()}`;
    let at = lower.indexOf(needle);
    while (at !== -1) {
      const end = at + needle.length;
      const boundary = end >= lower.length || !/[\p{L}\p{N}]/u.test(lower[end]);
      const overlaps = taken.some(([s, e]) => at < e && end > s);
      if (boundary && !overlaps) {
        taken.push([at, end]);
        if (id !== selfId && id !== authorId && !found.includes(name)) found.push(name);
      }
      at = lower.indexOf(needle, at + 1);
    }
  }
  return found;
}

/**
 * The same comment posted again — deleted and re-posted, or pasted twice —
 * gets a new update id, so the per-event dedupe lets it through and a second
 * full run answers the same words (#14591). Word-set overlap, @mentions
 * ignored. Pure.
 */
export function isRepost(previous: string, next: string): boolean {
  const words = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/@\S+(\s+\S+)?/g, " ")
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 1),
    );
  const a = words(previous);
  const b = words(next);
  if (a.size < 5 || b.size < 5) return false;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared) >= 0.9;
}

/**
 * A held reply the run must know about. A status change and the comment
 * explaining it usually land a minute apart, and each starts a run: without
 * this, the second drafted the same news to the customer again (#14542).
 */
function pendingReplyNote(ev: DevEvent): string {
  if (!ev.pendingReply) return "";
  return `\n\nA reply to the customer is ALREADY DRAFTED (${ev.pendingReply.at}) and waiting for a colleague to send it:\n"""\n${ev.pendingReply.body}\n"""\nDo not draft another reply that says the same thing. Call reply_to_ticket only if this event changes what the customer must hear; then write one complete reply, which replaces the pending one.`;
}

/** The event, as the last message of the run. */
export function devEventMessage(ev: DevEvent): string {
  const head = `[Dev board] Item "${ev.itemName}" — Dev Status: ${ev.devStatus ?? "unknown"}`;
  if (ev.kind === "comment") {
    const handoff = ev.addressedTo?.length
      ? `\n\nThis comment is addressed to ${ev.addressedTo.join(", ")}, not to you. It is colleagues talking to each other, so you cannot post on the dev item in this run. If it carries an answer or workaround for the customer, you may still draft the customer reply (a colleague sends it) and leave a private note. Do not ask the developer for anything.`
      : "";
    return `${head}\n${ev.author} commented on the item:\n"""\n${ev.text}\n"""${handoff}${pendingReplyNote(ev)}\n\nDecide, by the developer-run rules, what (if anything) to do.`;
  }
  const recent = ev.recent.length
    ? `Latest comments on the item, newest first:\n${ev.recent.map((r) => `- ${r.author} (${r.at}): ${r.text}`).join("\n")}`
    : "There are no comments on the item.";
  const what =
    ev.kind === "needs_info"
      ? "That means a developer is waiting on support. Work out what they need from the comments."
      : "That is a finished status.";
  return `${head}\n${ev.author} set Dev Status to "${ev.devStatus}". ${what}\n\n${recent}${pendingReplyNote(ev)}\n\nDecide, by the developer-run rules, what (if anything) to do.`;
}

function devBoardIds(): string[] {
  return [config.monday.boardIds.jetpackapps, config.monday.boardIds.getsign].filter((b): b is string => !!b);
}

/**
 * Entry point from the monday webhook. Never throws: the webhook has already
 * been acknowledged, and a failure here must only cost this one run.
 */
export async function handleDevBoardEvent(e: MondayWebhookEvent, opts: { requeued?: boolean } = {}): Promise<void> {
  if (config.devBridge === "off" && config.devKb === "off") return;
  const itemId = e.pulseId != null ? String(e.pulseId) : "";
  let lockToken: string | null = null;
  try {
    const state = await getActivityState();
    const selfId = state.mondaySelf?.id ?? null;
    const trigger = classifyDevEvent(e, devBoardIds(), selfId);

    // A person posting on an item with an open KB request is answering it —
    // including an update that is only a file, which is otherwise skipped as
    // an empty comment. That answer is for the KB, not the customer.
    const personPost = "kind" in trigger ? trigger.kind === "comment" : trigger.skip === "empty comment";
    if (personPost && config.devKb !== "off") {
      const askedAt = await pendingKbAsk(itemId);
      if (askedAt) {
        if (!(await markEventSeen(`devbridge:${e.triggerUuid ?? `${itemId}:${e.replyId ?? e.updateId}`}`, 24 * 3600))) return;
        const item = await monday.getDevItemSnapshot(itemId);
        if (item) await handleKbAnswer(item, (e.textBody ?? "").trim(), askedAt, selfId);
        return;
      }
    }
    if ("skip" in trigger) return;

    // monday redelivers; one event, one run. A requeued event was marked
    // the first time it arrived.
    const eventKey = e.triggerUuid ?? `${itemId}:${trigger.kind === "comment" ? trigger.postId : trigger.status}`;
    if (!opts.requeued && !(await markEventSeen(`devbridge:${eventKey}`, 24 * 3600))) return;
    if (trigger.kind === "comment" && trigger.postId && (await isRememberedJettaPost(trigger.postId))) return;
    if (trigger.kind === "comment" && config.devBridge !== "off") {
      const previous = await kvGet(lastCommentKey(itemId));
      // String(): Upstash parses a stored value that looks like JSON.
      if (previous != null && isRepost(String(previous), trigger.text)) {
        await logOpsEvent({ level: "info", event: "devbridge.skipped_repost", source: "webhook", data: { itemId } });
        return;
      }
    }

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

    // A finished bug: ask its developer, once, for something the KB can use.
    if (trigger.kind === "finished" && config.devKb !== "off" && shouldAskForKb(item, trigger.status)) {
      await askForKb(item).catch((err) => console.warn(`KB ask on ${itemId} failed:`, err));
    }
    if (config.devBridge === "off") return;

    // One run per item at a time. Two runs that overlap each miss what the
    // other is doing: the second can't see the first's comment or draft, and
    // asks the developer the same thing two minutes later (#14591). The later
    // event waits in a one-slot queue — newest wins, the run reads the whole
    // item anyway — and starts fresh when this run ends.
    lockToken = `${Date.now()}:${Math.random()}`;
    if (!(await kvSetNx(lockKey(itemId), lockToken, LOCK_SECONDS))) {
      await kvSet(queuedKey(itemId), JSON.stringify(e), QUEUE_SECONDS);
      // The running one may have finished between those two calls and found
      // the queue empty: take the item now rather than leave this stranded.
      if (await kvSetNx(lockKey(itemId), lockToken, LOCK_SECONDS)) {
        await kvDel(queuedKey(itemId));
      } else {
        lockToken = null;
      }
    }
    if (!lockToken) {
      await logOpsEvent({
        level: "info",
        event: "devbridge.deferred",
        source: "webhook",
        ticketId,
        data: { itemId, kind: trigger.kind },
      });
      return;
    }
    if (trigger.kind === "comment") await kvSet(lastCommentKey(itemId), trigger.text.slice(0, 4000), REPOST_SECONDS);

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
    const authorKey = e.userId != null ? String(e.userId) : "";
    const authorId = trigger.kind === "comment" && authorKey && authorKey !== selfId ? authorKey : undefined;
    const addressedTo = trigger.kind === "comment" ? addressedNames(trigger.text, users, selfId, authorKey) : [];
    const pending = await getPendingReplyDraftForTicket(ticketId).catch(() => null);
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
      authorId,
      addressedTo: addressedTo.length ? addressedTo : undefined,
      text: trigger.kind === "comment" ? trigger.text.slice(0, 3000) : undefined,
      threadUpdateId: trigger.kind === "comment" ? trigger.threadUpdateId : undefined,
      developers: item.developers,
      recent,
      pendingReply: pending
        ? { at: new Date(pending.createdAt * 1000).toISOString(), body: pending.suggestedReply.slice(0, 3000) }
        : undefined,
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
      { tier: "devbridge", ...(shadow ? { dryRun: true } : draftMode ? { holdCustomerWrites: true } : {}) },
    );
    await recordRun("devboard", ctx, result, Date.now() - started);
    const draft = !shadow && draftMode ? await createDraftFromRun(ctx, result, { replyToolOnly: true }) : null;

    // A developer answered a Question item and the answer went (or, held, will
    // go) to the customer: that answer is KB material.
    if (
      config.devKb !== "off" &&
      ev.kind === "comment" &&
      /question/i.test(item.type ?? "") &&
      result.toolsUsed.includes("reply_to_ticket")
    ) {
      await draftFromItem(item, "question answered").catch((err) => console.warn(`KB draft for ${itemId} failed:`, err));
    }

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
        ...(ev.addressedTo ? { addressedTo: ev.addressedTo } : {}),
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
  } finally {
    if (lockToken) await releaseAndDrain(itemId, lockToken).catch((err) => console.warn(`dev bridge unlock ${itemId}:`, err));
  }
}

const LOCK_SECONDS = 300; // the webhook function's maxDuration: a crashed run can't hold the item longer
const QUEUE_SECONDS = 1800;
const REPOST_SECONDS = 1800;
const lockKey = (itemId: string) => `jetta:devbridge:running:${itemId}`;
const queuedKey = (itemId: string) => `jetta:devbridge:queued:${itemId}`;
const lastCommentKey = (itemId: string) => `jetta:devbridge:lastcomment:${itemId}`;

/**
 * Free the item and start the event that waited for it. The waiting run goes
 * to a fresh invocation of the webhook route: this one has spent most of its
 * 300 s already, and a second ticket run would not fit.
 */
async function releaseAndDrain(itemId: string, token: string): Promise<void> {
  if ((await kvGet(lockKey(itemId))) === token) await kvDel(lockKey(itemId));
  const queued = await kvGet(queuedKey(itemId));
  if (!queued) return;
  await kvDel(queuedKey(itemId));
  if (!config.appUrl || !config.webhook.secret) {
    console.warn(`dev bridge: queued event on ${itemId} dropped, no JETTA_APP_URL to requeue to`);
    return;
  }
  const event = typeof queued === "string" ? JSON.parse(queued) : queued;
  const res = await fetch(`${config.appUrl}/api/webhook/monday-activity?k=${encodeURIComponent(config.webhook.secret)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event, requeued: true }),
  });
  if (!res.ok) console.warn(`dev bridge: requeue of ${itemId} answered ${res.status}`);
}
