/**
 * Slack tool client — escalation + partner notifications, plus a helper for
 * the admin command interface to post threaded replies.
 */
import { config } from "../config";
import { clearEscalation, getEscalationTs, recordEscalation } from "../kv";
import type { AttachmentFile } from "../types";

/**
 * Where non-dev, non-chat notifications go.
 *
 * Falls back to the escalation channel so nothing is ever silently dropped
 * while the channel is being set up — but says so once per process, because a
 * fallback that nobody notices is how four unrelated kinds of message ended up
 * sharing one channel in the first place.
 */
let warnedNoOpsChannel = false;
function opsChannel(): string {
  if (config.slack.opsChannel) return config.slack.opsChannel;
  if (!warnedNoOpsChannel) {
    warnedNoOpsChannel = true;
    console.warn(
      "SLACK_OPS_CHANNEL is not set — approvals and KB reports are falling back to the escalation channel.",
    );
  }
  return config.slack.escalationChannel ?? "#jetta-escalations";
}

let warnedNoChatChannel = false;
function chatChannel(): string {
  if (config.slack.chatChannel) return config.slack.chatChannel;
  if (!warnedNoChatChannel) {
    warnedNoChatChannel = true;
    console.warn(
      "SLACK_CHAT_CHANNEL is not set — visitors waiting for a person are being announced in the escalation channel.",
    );
  }
  return config.slack.escalationChannel ?? "#jetta-escalations";
}

// Distinct per stubbed post. A single fixed ts made every stubbed message look
// like the same message, so anything that threads onto a ts it was handed —
// escalation updates especially — could not be exercised without a live token.
let stubTs = 0;

/**
 * `broadcast` mirrors a threaded message into the channel as well. Slack shows
 * it as a one-line reference back to the thread, so it is much lighter than a
 * second top-level post — the point is to be seen without fragmenting the issue.
 */
async function postMessage(
  channel: string,
  text: string,
  threadTs?: string,
  broadcast = false,
): Promise<string> {
  if (!config.slack.live) {
    const how = threadTs ? ` (thread ${threadTs}${broadcast ? ", broadcast" : ""})` : "";
    console.log(`[stub] slack → ${channel}${how}:\n${text}`);
    return `0000000000.${String(++stubTs).padStart(6, "0")}`;
  }
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.slack.botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel,
      text,
      thread_ts: threadTs,
      // Meaningless without thread_ts, and Slack rejects the combination.
      reply_broadcast: threadTs && broadcast ? true : undefined,
    }),
  });
  const json = (await res.json()) as { ok: boolean; error?: string; ts?: string };
  if (json.ok) return json.ts ?? "";

  // A channel that does not exist, or that Jetta was never invited to, is the
  // predictable failure of splitting notifications across channels: someone
  // sets SLACK_CHAT_CHANNEL, forgets to invite the bot, and a visitor waiting
  // for a person is announced to nobody. Fall back to the channel we know
  // works rather than lose the message, and say loudly what happened.
  const missing = json.error === "channel_not_found" || json.error === "not_in_channel";
  const fallback = config.slack.escalationChannel ?? "#jetta-escalations";
  if (missing && channel !== fallback) {
    console.error(
      `Slack: ${channel} is ${json.error === "not_in_channel" ? "not a channel Jetta has been invited to" : "unknown"} — posting to ${fallback} instead. Create it and invite the bot, or fix the setting.`,
    );
    return await postMessage(fallback, `:warning: _(intended for ${channel})_\n${text}`, threadTs, broadcast);
  }
  throw new Error(`Slack postMessage failed: ${json.error}`);
}

/**
 * Collapse to one line and cap length so the channel view stays scannable. The
 * untruncated text always survives in the thread reply, so this never loses
 * information — it only shortens what a reader sees before expanding.
 */
function clamp(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** True when `clamp` shortened the text, so the thread must carry it in full. */
function clamped(s: string, max: number): boolean {
  return s.replace(/\s+/g, " ").trim().length > max;
}

const HEADLINE_MAX = 90;
const QUESTION_MAX = 180;
const FLAG_MAX = 100;

/** Slack `<url|label>` when we have a real URL, so long hrefs don't eat a line. */
function link(url: string | undefined, label: string): string {
  return url && /^https?:\/\//.test(url) ? `<${url}|${label}>` : label;
}

/**
 * Turn monday ids the model wrote as prose into clickable links.
 *
 * The structured links (ticket, account, dev item) were always linked — but the
 * model also refers to boards and items inside its own sentences, and those
 * arrived as bare digits nobody could click: "…failure on source board
 * 5850411194…", "…same root cause as dev board item 11735712226…". A reader had
 * to copy the number and go hunting.
 *
 * Two different things get linked, and they resolve against different accounts:
 *   - OUR dev board items → `devBoardId`, which the caller knows from the ticket's
 *     product.
 *   - the CUSTOMER's boards → their own monday account, which we only link when a
 *     monday URL for it appears in the same escalation. A board link pointed at
 *     the wrong account is worse than plain text, so absent that evidence the id
 *     is left exactly as written.
 *
 * Ids already inside a Slack `<url|label>` are skipped — the split below keeps
 * existing links intact rather than linking their innards a second time.
 */
// The two shapes a dev item is written in, kept as sources so every use builds
// a fresh regex — a shared /g regex carries lastIndex between calls and starts
// skipping matches. The TITLED form requires the id in brackets: without that
// anchor its unquoted-title branch is greedy and swallows a preceding id.
const DEV_ITEM_KEYWORD = String.raw`\b(dev(?:elopment)?[\s-]?board\s+item|dev\s+item)\b`;
const DEV_ITEM_SRC = `${DEV_ITEM_KEYWORD}([\\s:#*_~]*)(\\d{6,})\\b`;
const DEV_ITEM_TITLED_SRC = `${DEV_ITEM_KEYWORD}([\\s:#*_~]*(?:"[^"\\n]{0,90}"|[^()\\n.]{0,60})\\s*)\\((\\d{6,})\\)`;

/** Bare dev-item ids in prose, for callers that must resolve their boards first. */
export function devItemIdsIn(text: string): string[] {
  const ids = [
    ...[...text.matchAll(new RegExp(DEV_ITEM_TITLED_SRC, "gi"))].map((m) => m[3]),
    ...[...text.matchAll(new RegExp(DEV_ITEM_SRC, "gi"))].map((m) => m[3]),
  ];
  return [...new Set(ids)];
}

export function linkifyMondayIds(
  text: string,
  opts: {
    /**
     * The dev board an item id belongs to. A plain string when the caller knows
     * it (an escalation knows its product); a lookup when it does not (a Slack
     * DM can mention an item from either board) — returning undefined for an
     * id leaves that number as plain text rather than linking it to a guess.
     */
    devBoardId?: string | ((itemId: string) => string | undefined);
    accountUrl?: string;
  } = {},
): string {
  const base = config.monday.accountUrl;
  // The customer's monday account, taken from the escalation itself. Ours is
  // excluded: "jetpackteam.monday.com" appearing in the text says nothing about
  // where the customer's boards live.
  const ourSlug = /https?:\/\/([a-z0-9-]+)\.monday\.com/i.exec(base)?.[1]?.toLowerCase();
  // OUR account must be filtered out of BOTH sources, not just the message
  // body. An escalation usually links its dev item first, so taking the first
  // monday URL unfiltered picked jetpackteam and then pointed the customer's
  // board id at our own workspace — the precise wrong-account link this whole
  // function exists to avoid.
  const slugsIn = (s: string) =>
    [...s.matchAll(/https?:\/\/([a-z0-9-]+)\.monday\.com/gi)]
      .map((m) => m[1].toLowerCase())
      .filter((slug) => slug !== ourSlug && slug !== "www");
  const customerSlug = slugsIn(opts.accountUrl ?? "")[0] ?? slugsIn(text)[0];

  // "dev board item 123" directly, and the titled forms the model favours:
  //   dev board item "TrackMy not updating after bulk update" (12757964338)
  //   dev board item: VLookUp Template not working (11735712226)
  const DEV_ITEM = new RegExp(DEV_ITEM_SRC, "gi");
  const DEV_ITEM_TITLED = new RegExp(DEV_ITEM_TITLED_SRC, "gi");
  // "board 5850411194", "source/target/test board 5850411194", "board (5850411194)".
  // The separator is captured rather than assumed, so the author's own spacing
  // and brackets survive the rewrite.
  // The separator allows Slack's own formatting characters: she writes
  // "*Source board:* 5850411194", and an asterisk sitting between the label and
  // the number was quietly defeating every match in real answers.
  const BOARD = /\b((?:source|target|test|shared|connected)?\s*board)\b(\s*(?:is|id)?[\s:#*_~]*\(?)(\d{6,})\b/gi;

  const boardFor = (itemId: string): string | undefined =>
    typeof opts.devBoardId === "function" ? opts.devBoardId(itemId) : opts.devBoardId;

  const linkOutside = (segment: string): string => {
    let out = segment;
    if (opts.devBoardId) {
      const devLink = (id: string) => {
        const board = boardFor(id);
        return board ? `<${base}/boards/${board}/pulses/${id}|${id}>` : id;
      };
      out = out.replace(DEV_ITEM_TITLED, (m, kw: string, mid: string, id: string) =>
        // "dev item helped, board 5850411194" must not read as an item id — if
        // the words in between mention a board, this is a different subject.
        /\bboards?\b/i.test(mid) ? m : `${kw}${mid}(${devLink(id)})`,
      );
      out = out.replace(DEV_ITEM, (_m, kw: string, mid: string, id: string) => `${kw}${mid}${devLink(id)}`);
    }
    if (customerSlug) {
      out = out.replace(BOARD, (_m, kw: string, sep: string, id: string) => {
        // Our own dev board id in prose is ours, not theirs.
        const slug = id === boardFor(id) || id === opts.devBoardId ? ourSlug : customerSlug;
        return `${kw}${sep}<https://${slug}.monday.com/boards/${id}|${id}>`;
      });
    }
    return out;
  };

  // Preserve anything already inside <…>: Slack links, mailto:, channel refs.
  return text
    .split(/(<[^<>]*>)/g)
    .map((part) => (part.startsWith("<") && part.endsWith(">") ? part : linkOutside(part)))
    .join("");
}

/** Human-readable app name for message headlines. */
export function appLabel(app: string): string {
  const names: Record<string, string> = {
    vlookup: "VLOOKUP Auto-Link",
    trackmy: "TrackMy",
    extract: "Extract AI",
    jobflows: "JobFlows",
    smartcolumns: "Smart Columns",
    jetscan: "JetScan",
    pivotreports: "Pivot Reports",
    triggerly: "Triggerly",
    getsign: "GetSign",
  };
  return names[app] ?? "Jetpack Apps";
}

/**
 * Turn `alreadyTried` into bullets. The model is asked for one attempt per line;
 * this also splits semicolon-joined prose so older-style single-sentence answers
 * still read as a list.
 */
function bulletize(text: string): string {
  let parts = text
    .split("\n")
    .map((l) => l.replace(/^\s*[-•*]\s*/, "").trim())
    .filter(Boolean);
  if (parts.length === 1 && parts[0].split("; ").length > 1) {
    parts = parts[0].split("; ").map((p) => p.trim()).filter(Boolean);
  }
  return parts.map((p) => `• ${p}`).join("\n");
}

export interface EscalationInput {
  freshdeskTicketUrl: string;
  userAccountUrl: string;
  /** Dev board item URL, when create_dev_item ran earlier this turn. Internal channel only. */
  mondayItemUrl?: string;
  /** Scannable one-liner naming the failure — the only thing most readers see. */
  headline: string;
  /** Which app the escalation concerns, for the headline prefix. */
  app?: string;
  /** Our dev board for this product — lets prose item ids become links. */
  devBoardId?: string;
  /** Short account label for the links line (email or slug), not a URL. */
  accountLabel?: string;
  /** Ticket reference for the links line, e.g. "#13842". */
  ticketRef?: string;
  /** One-paragraph summary of the issue. Thread reply only. */
  summary: string;
  /** What Jetta already tried. Thread reply only. */
  alreadyTried: string;
  /** A specific question for the dev team. */
  question: string;
  /**
   * Ticket/conversation id, used to find this ticket's existing escalation so a
   * second one becomes an update on it. Omit only when there is no ticket.
   */
  ticketId?: string;
  /**
   * The team needs to see this now. Only affects an update on an existing
   * escalation, which otherwise lands in a thread that people who are not
   * already following it never see — the customer sitting on a live call is
   * exactly the case where quiet is the wrong default.
   */
  urgent?: boolean;
}

/**
 * Post an escalation to #jetta-escalations as a SHORT parent message plus a
 * threaded reply holding the full context. Slack collapses the reply to
 * "1 reply", so the channel stays skimmable and detail is one click away —
 * and `@Jetta draft kb` still sees everything, since it reads the whole thread.
 *
 * A ticket gets ONE escalation thread. When it has escalated before, the new
 * context is posted as an update inside that thread rather than as a second
 * top-level post — see the note on the escalation store in lib/kv.ts for why
 * Jetta kept raising the same issue twice. `updated` in the return says which
 * happened, so the caller can tell the model what it actually did.
 */
export async function sendEscalation(
  input: EscalationInput,
): Promise<{ ts: string; updated: boolean }> {
  const channel = config.slack.escalationChannel ?? "#jetta-escalations";
  // Model-authored prose only. The structured refs below are already links, and
  // the customer's account is resolved across the whole escalation rather than
  // per field, so a board id in the question still links when the account URL
  // only appears in the summary.
  const linkify = (t: string) =>
    linkifyMondayIds(t, {
      devBoardId: input.devBoardId,
      accountUrl: [input.userAccountUrl, input.summary, input.alreadyTried, input.question]
        .filter(Boolean)
        .join("\n"),
    });
  const question = linkify(input.question);
  const summary = linkify(input.summary);
  const alreadyTried = linkify(input.alreadyTried);
  const prefix = input.app ? `${appLabel(input.app)} · ` : "";
  const refs = [
    link(input.freshdeskTicketUrl, input.ticketRef ?? "Ticket"),
    input.accountLabel,
    input.mondayItemUrl ? link(input.mondayItemUrl, "Dev item") : undefined,
  ].filter(Boolean);

  // An update on an escalation the team has already seen. Nothing is clamped
  // here — a thread reply costs no channel real estate, so the team gets the
  // new context in full — and the ticket/account links are left off because the
  // parent two messages up already carries them. The Dev item does repeat: it
  // is often the thing that changed since the last post.
  const update = [
    `${input.urgent ? ":rotating_light: *Urgent update" : ":arrows_counterclockwise: *Update"} — ${linkify(input.headline)}*`,
    ...(input.mondayItemUrl ? [link(input.mondayItemUrl, "Dev item")] : []),
    `:question: ${question}`,
    "",
    `*What's new*`,
    summary.trim(),
    "",
    `*Already tried*`,
    bulletize(alreadyTried),
  ].join("\n");

  const priorTs = input.ticketId ? await getEscalationTs(input.ticketId) : null;
  if (priorTs) {
    try {
      // Urgent updates are mirrored into the channel too — a thread reply only
      // notifies people already following it, and "customer is on a call right
      // now" must not depend on who happened to open the thread.
      await postMessage(channel, update, priorTs, input.urgent === true);
      return { ts: priorTs, updated: true };
    } catch (e) {
      // The remembered thread is gone — most likely pruned, since the team
      // clears this channel as issues close. Forget it and escalate afresh
      // below rather than dropping an update nobody would ever see.
      console.warn(
        `escalation update for ${input.ticketId} could not reach thread ${priorTs} — posting a new escalation:`,
        e instanceof Error ? e.message : e,
      );
      if (input.ticketId) await clearEscalation(input.ticketId);
    }
  }

  const parent = [
    // clamp() would cut mid-link and leave broken markup in the channel, so the
    // headline is shortened before linking and the question falls back to its
    // plain form whenever it needs truncating (the thread carries it in full).
    `:rotating_light: *${prefix}${linkify(clamp(input.headline, HEADLINE_MAX))}*`,
    refs.join(" · "),
    `:question: ${clamped(input.question, QUESTION_MAX) ? clamp(input.question, QUESTION_MAX) : question}`,
  ].join("\n");
  const ts = await postMessage(channel, parent);
  if (input.ticketId) await recordEscalation(input.ticketId, ts);

  const detail = [
    // Only repeat what the parent had to shorten — otherwise it's pure duplication.
    ...(clamped(input.question, QUESTION_MAX)
      ? [`*Question for the team*`, question.trim(), ""]
      : []),
    `*Issue*`,
    summary.trim(),
    "",
    `*Already tried*`,
    bulletize(alreadyTried),
    "",
    `*Links*`,
    `Ticket: ${input.freshdeskTicketUrl}`,
    `Account: ${input.userAccountUrl}`,
    ...(input.mondayItemUrl ? [`Dev board item: ${input.mondayItemUrl}`] : []),
  ].join("\n");
  // The parent is already posted; a failed detail reply must not report the
  // whole escalation as failed — the team still has the headline and question.
  await postMessage(channel, detail, ts).catch((e) =>
    console.warn("escalation detail reply failed:", e instanceof Error ? e.message : e),
  );

  return { ts, updated: false };
}

export interface MonetApprovalRequest {
  id: string;
  action: "trial" | "discount";
  app: string;
  accountSlug: string;
  /** Human-readable summary of what will happen, e.g. "extend trial by 7 days". */
  summary: string;
  ticketUrl?: string;
  /** Abuse/heads-up note surfaced to the reviewer, if any. */
  flagged?: string;
}

/**
 * Post a trial/discount approval request to the escalation channel, WITH the
 * exact Slack commands to approve or reject. A human runs one of them; the
 * approve path then executes the monday call.
 */
export async function requestMonetApproval(req: MonetApprovalRequest): Promise<{ ts: string }> {
  // A yes/no for a person, not a bug for an engineer.
  const channel = opsChannel();
  const icon = req.action === "trial" ? ":hourglass_flowing_sand:" : ":money_with_wings:";
  // The approve/reject commands are the point of this message, so they stay in
  // the parent. Only the flag rationale and the expiry caveat move to the thread.
  const parent = [
    `${icon} *${appLabel(req.app)} ${req.action}* — ${clamp(req.summary, 90)}`,
    [link(req.ticketUrl, "Ticket"), `\`${req.accountSlug}\``, `ref \`${req.id}\``]
      .filter(Boolean)
      .join(" · "),
    ...(req.flagged
      ? [`:triangular_flag_on_post: *Flagged* — ${clamp(req.flagged, FLAG_MAX)}`]
      : []),
    `Approve: \`@Jetta approve monet ${req.id}\`  ·  Reject: \`@Jetta reject monet ${req.id}\``,
  ].join("\n");
  const ts = await postMessage(channel, parent);

  const detail = [
    // The parent already shows short flags in full; only re-state a long one.
    ...(req.flagged && clamped(req.flagged, FLAG_MAX)
      ? [`*Flagged for review*`, req.flagged.trim(), ""]
      : []),
    `*Action requested*`,
    req.summary.trim(),
    "",
    ...(req.ticketUrl ? [`Ticket: ${req.ticketUrl}`] : [`_Requested by Jetta._`]),
    `Account: \`${req.accountSlug}\``,
    `_Nothing happens on monday until an admin approves. This request expires in 3 days._`,
  ].join("\n");
  await postMessage(channel, detail, ts).catch((e) =>
    console.warn("monet approval detail reply failed:", e instanceof Error ? e.message : e),
  );

  return { ts };
}

/**
 * Ping the team that a Jetta draft reply is waiting for review (draft mode).
 * Only posts when a DEDICATED drafts channel is configured — we never fall back
 * to the escalations channel, since a ping per held draft is noise there. Drafts
 * are always reviewable via the Freshdesk private note and the /drafts console.
 */
export async function notifyDraftPending(input: {
  subject: string;
  ticketUrl: string;
  consoleUrl: string;
}): Promise<void> {
  const channel = config.slack.draftsChannel;
  if (!channel) return;
  await postMessage(
    channel,
    [
      `:memo: *Draft reply pending review*`,
      `*Ticket:* ${input.subject}`,
      `Review & reply in Freshdesk (draft is in a private note): ${input.ticketUrl}`,
      `Console fallback: ${input.consoleUrl}/drafts`,
    ].join("\n"),
  );
}

/**
 * Daily KB-sync summary — posted only when something changed or was flagged.
 * One-line totals in the channel; the per-site breakdown goes in the thread.
 */
/**
 * A visitor is waiting for a person, right now.
 *
 * Posted to the chat channel rather than the escalation channel: escalations
 * are async dev work someone reads when they get to it, and this is a human
 * standing at the counter. Falls back to the escalation channel if no separate
 * one is configured — a ping in the wrong room beats no ping.
 */
export async function notifyChatHandoff(input: {
  conversationId: string;
  visitor: string;
  reason: string;
  lastMessage: string;
  consoleUrl: string;
}): Promise<void> {
  const channel = chatChannel();
  const text = [
    `:wave: *A visitor is asking for a person* — ${input.visitor}`,
    `> ${clamp(input.lastMessage, 200)}`,
    `Why: ${clamp(input.reason, 140)}`,
    `<${input.consoleUrl}/chats/${input.conversationId}|Open the conversation> — Jetta has gone quiet and is waiting for you.`,
  ].join("\n");
  await postMessage(channel, text);
}

export async function notifyKbSync(headline: string, details: string[]): Promise<void> {
  // A daily cron report. It belongs where routine operational noise lives, not
  // in the channel someone is watching for things that are on fire.
  const channel = config.slack.draftsChannel ?? opsChannel();
  const ts = await postMessage(channel, `:books: *KB sync* — ${clamp(headline, 120)}`);
  if (!details.length) return;
  await postMessage(channel, details.join("\n"), ts).catch((e) =>
    console.warn("kb-sync detail reply failed:", e instanceof Error ? e.message : e),
  );
}

/** Notify #partnerships when a user mentions an external implementation partner. */
export async function notifyPartnerManager(
  freshdeskTicketUrl: string,
  partnerMention: string,
): Promise<void> {
  const channel = config.slack.partnershipsChannel ?? "#partnerships";
  await postMessage(
    channel,
    [
      `:handshake: *Possible external partner mentioned*`,
      `*Ticket:* ${freshdeskTicketUrl}`,
      `*Mention:* ${partnerMention}`,
      `_No automated partner lookup in v1 — please review._`,
    ].join("\n"),
  );
}

/** Reply in a Slack thread (used by the admin command interface). */
/**
 * Assistant-thread helpers. These only apply to Jetta's agent panel / DM
 * threads; every one is best-effort cosmetics, so a failure must never stop
 * the actual answer from being posted.
 */
export async function setAssistantStatus(channel: string, threadTs: string, status: string): Promise<void> {
  await fetch("https://slack.com/api/assistant.threads.setStatus", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.slack.botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel_id: channel, thread_ts: threadTs, status }),
  }).catch(() => {});
}

export async function setAssistantSuggestedPrompts(
  channel: string,
  threadTs: string,
  prompts: { title: string; message: string }[],
  title?: string,
): Promise<void> {
  await fetch("https://slack.com/api/assistant.threads.setSuggestedPrompts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.slack.botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel_id: channel, thread_ts: threadTs, prompts, title }),
  }).catch(() => {});
}

/** Read a DM's recent messages (no thread) — the plain-DM equivalent of readThread. */
export async function readIm(channel: string, limit = 12): Promise<ThreadMessage[]> {
  const res = await fetch(
    `https://slack.com/api/conversations.history?channel=${encodeURIComponent(channel)}&limit=${limit}`,
    { headers: { Authorization: `Bearer ${config.slack.botToken}` } },
  );
  const json = (await res.json()) as {
    ok: boolean;
    error?: string;
    messages?: { text?: string; bot_id?: string; user?: string; ts?: string }[];
  };
  if (!json.ok) throw new Error(`Slack conversations.history failed: ${json.error}`);
  // Oldest first, matching readThread.
  return (json.messages ?? [])
    .reverse()
    .map((m) => ({ text: m.text ?? "", isBot: !!m.bot_id, user: m.user ?? "" }));
}

export async function replyInThread(
  channel: string,
  threadTs: string,
  text: string,
): Promise<void> {
  await postMessage(channel, text, threadTs);
}

export interface ThreadMessage {
  user: string;
  text: string;
  isBot: boolean;
}

// ── File delivery ──────────────────────────────────────────────────

export interface UploadOutcome {
  uploaded: string[];
  failed: { name: string; reason: string }[];
}

/**
 * Put files into a Slack conversation.
 *
 * Three calls per batch, which is Slack's current upload flow: ask for a signed
 * URL per file, PUT the bytes at it, then complete them all in ONE
 * `completeUploadExternal` so the thread gets a single message carrying every
 * file rather than one message per screenshot.
 *
 * `channel` and `threadTs` come from the event being answered, never from a
 * model argument — see the note on `send_ticket_files` in lib/slack-assistant.ts.
 *
 * Failures are returned, not thrown and not swallowed. The caller reports them
 * to the person waiting: "I couldn't send that" is recoverable, while silence
 * after "sending them over" is the failure that wastes someone's afternoon.
 */
export async function uploadFiles(
  channel: string,
  threadTs: string | undefined,
  files: AttachmentFile[],
  comment?: string,
): Promise<UploadOutcome> {
  const sendable = files.filter((f) => f.data.byteLength > 0);
  const failed: { name: string; reason: string }[] = files
    .filter((f) => f.data.byteLength === 0)
    .map((f) => ({ name: f.name, reason: "the file is empty" }));

  if (!sendable.length) return { uploaded: [], failed };

  if (!config.slack.live) {
    console.log(
      `[stub] slack upload → ${channel}${threadTs ? ` (thread ${threadTs})` : ""}: ${sendable.map((f) => f.name).join(", ")}`,
    );
    return { uploaded: sendable.map((f) => f.name), failed };
  }

  const auth = { Authorization: `Bearer ${config.slack.botToken}` };
  const ready: { id: string; title: string }[] = [];

  for (const f of sendable) {
    try {
      const ticketRes = await fetch("https://slack.com/api/files.getUploadURLExternal", {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/x-www-form-urlencoded" },
        // `length` must be the exact byte count — Slack rejects the upload later
        // if the body doesn't match what was reserved here.
        body: new URLSearchParams({ filename: f.name, length: String(f.data.byteLength) }),
      });
      const slot = (await ticketRes.json()) as {
        ok: boolean;
        error?: string;
        upload_url?: string;
        file_id?: string;
      };
      if (!slot.ok || !slot.upload_url || !slot.file_id) {
        failed.push({ name: f.name, reason: describeUploadError(slot.error) });
        continue;
      }

      const put = await fetch(slot.upload_url, { method: "POST", body: new Uint8Array(f.data) });
      if (!put.ok) {
        failed.push({ name: f.name, reason: `upload rejected (HTTP ${put.status})` });
        continue;
      }
      ready.push({ id: slot.file_id, title: f.name });
    } catch (e) {
      failed.push({ name: f.name, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  if (!ready.length) return { uploaded: [], failed };

  const doneRes = await fetch("https://slack.com/api/files.completeUploadExternal", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      files: ready,
      channel_id: channel,
      thread_ts: threadTs,
      initial_comment: comment,
    }),
  });
  const done = (await doneRes.json()) as { ok: boolean; error?: string };
  if (!done.ok) {
    return {
      uploaded: [],
      failed: [...failed, ...ready.map((r) => ({ name: r.title, reason: describeUploadError(done.error) }))],
    };
  }

  return { uploaded: ready.map((r) => r.title), failed };
}

/** Slack's error codes, translated into something a person can act on. */
function describeUploadError(error: string | undefined): string {
  switch (error) {
    case "missing_scope":
    case "not_allowed_token_type":
      return "Jetta is missing the files:write scope — add it in the Slack app config and reinstall.";
    case "not_in_channel":
      return "Jetta is not a member of this channel.";
    case "file_uploads_disabled":
      return "file uploads are disabled for this workspace.";
    default:
      return `Slack said: ${error ?? "unknown error"}`;
  }
}

/**
 * Read all messages in a thread (for the Knowledge Loop). Requires the
 * `channels:history` (and/or `groups:history`) bot scope.
 */
export async function readThread(channel: string, threadTs: string): Promise<ThreadMessage[]> {
  if (config.stubMode && !config.slack.live) {
    return [];
  }
  const url = `https://slack.com/api/conversations.replies?channel=${encodeURIComponent(
    channel,
  )}&ts=${encodeURIComponent(threadTs)}&limit=100`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${config.slack.botToken}` },
  });
  const json = (await res.json()) as {
    ok: boolean;
    error?: string;
    messages?: { user?: string; bot_id?: string; text?: string }[];
  };
  if (!json.ok) throw new Error(`Slack conversations.replies failed: ${json.error}`);
  return (json.messages ?? []).map((m) => ({
    user: m.user ?? m.bot_id ?? "unknown",
    text: m.text ?? "",
    isBot: !!m.bot_id,
  }));
}

// ── Configuration health ───────────────────────────────────────────

export interface ChannelCheck {
  /** The env var this came from, for an error message that says what to fix. */
  setting: string;
  /** Configured value: a channel id, or a #name. */
  value?: string;
  name?: string;
  ok: boolean;
  /** Why not, in words a person can act on. */
  problem?: string;
}

/**
 * Can Jetta actually post where she is pointed?
 *
 * Checks each configured channel directly rather than listing the workspace:
 * one call per channel, and it works for private channels, which all of ours
 * are. `is_member` is the field that matters — a channel that exists but has
 * no Jetta in it accepts no messages, and that is the mistake this catches
 * (create the channel, set the variable, forget the invite).
 *
 * Read-only and never posts. Degrades to "cannot check" rather than "broken"
 * when the scope is missing: an unverifiable channel is not a failing one.
 */
export async function checkChannels(): Promise<ChannelCheck[]> {
  const configured: { setting: string; value?: string }[] = [
    { setting: "SLACK_ESCALATION_CHANNEL", value: config.slack.escalationChannel },
    { setting: "SLACK_CHAT_CHANNEL", value: config.slack.chatChannel },
    { setting: "SLACK_OPS_CHANNEL", value: config.slack.opsChannel },
  ];

  if (!config.slack.live || !config.slack.botToken) {
    return configured.map((c) => ({ ...c, ok: false, problem: "Slack is not connected in this environment." }));
  }

  return await Promise.all(
    configured.map(async ({ setting, value }): Promise<ChannelCheck> => {
      if (!value) {
        return {
          setting,
          ok: false,
          problem: "Not set — these messages fall back to the escalation channel.",
        };
      }
      try {
        const res = await fetch(
          `https://slack.com/api/conversations.info?channel=${encodeURIComponent(value.replace(/^#/, ""))}`,
          { headers: { Authorization: `Bearer ${config.slack.botToken}` } },
        );
        const j = (await res.json()) as {
          ok: boolean;
          error?: string;
          channel?: { name?: string; is_member?: boolean; is_private?: boolean };
        };
        if (!j.ok) {
          const problem =
            j.error === "missing_scope"
              ? "Can't check — Jetta needs the channels:read scope (groups:read for private channels)."
              : j.error === "channel_not_found"
                ? "No such channel. Check the id, or invite Jetta if it is private."
                : `Slack said: ${j.error}`;
          return { setting, value, ok: false, problem };
        }
        if (!j.channel?.is_member) {
          return {
            setting,
            value,
            name: j.channel?.name,
            ok: false,
            problem: `Jetta is not in #${j.channel?.name ?? value} — run /invite @Jetta there.`,
          };
        }
        return { setting, value, name: j.channel.name, ok: true };
      } catch (e) {
        return { setting, value, ok: false, problem: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
}
