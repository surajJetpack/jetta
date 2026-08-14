/**
 * Slack tool client — escalation + partner notifications, plus a helper for
 * the admin command interface to post threaded replies.
 */
import { config } from "../config";

async function postMessage(channel: string, text: string, threadTs?: string): Promise<string> {
  if (!config.slack.live) {
    console.log(`[stub] slack → ${channel}${threadTs ? ` (thread ${threadTs})` : ""}:\n${text}`);
    return "0000000000.000000";
  }
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.slack.botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, text, thread_ts: threadTs }),
  });
  const json = (await res.json()) as { ok: boolean; error?: string; ts?: string };
  if (!json.ok) throw new Error(`Slack postMessage failed: ${json.error}`);
  return json.ts ?? "";
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
export function linkifyMondayIds(
  text: string,
  opts: { devBoardId?: string; accountUrl?: string } = {},
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

  // "dev board item 123" / "dev item 123", directly.
  const DEV_ITEM = /\b(dev(?:elopment)?[\s-]?board\s+item|dev\s+item)\b([\s:#]*)(\d{6,})\b/gi;
  // The forms the model actually favours, with the item's title in between:
  //   dev board item "TrackMy not updating after bulk update" (12757964338)
  //   dev board item: VLookUp Template not working (11735712226)
  // The id must be parenthesised here — without that anchor an unquoted title
  // could run on into a following clause and swallow an unrelated number.
  const DEV_ITEM_TITLED =
    /\b(dev(?:elopment)?[\s-]?board\s+item|dev\s+item)\b([\s:#]*(?:"[^"\n]{0,90}"|[^()\n.]{0,60})\s*)\((\d{6,})\)/gi;
  // "board 5850411194", "source/target/test board 5850411194", "board (5850411194)".
  // The separator is captured rather than assumed, so the author's own spacing
  // and brackets survive the rewrite.
  const BOARD = /\b((?:source|target|test|shared|connected)?\s*board)\b(\s*(?:is|id)?[\s:#]*\(?)(\d{6,})\b/gi;

  const linkOutside = (segment: string): string => {
    let out = segment;
    if (opts.devBoardId) {
      const devLink = (id: string) => `<${base}/boards/${opts.devBoardId}/pulses/${id}|${id}>`;
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
        const slug = id === opts.devBoardId ? ourSlug : customerSlug;
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
  /** Dev board item URL, when create_dev_item/add_plus_one ran earlier this turn. Internal channel only. */
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
}

/**
 * Post an escalation to #jetta-escalations as a SHORT parent message plus a
 * threaded reply holding the full context. Slack collapses the reply to
 * "1 reply", so the channel stays skimmable and detail is one click away —
 * and `@Jetta draft kb` still sees everything, since it reads the whole thread.
 */
export async function sendEscalation(input: EscalationInput): Promise<{ ts: string }> {
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

  const parent = [
    // clamp() would cut mid-link and leave broken markup in the channel, so the
    // headline is shortened before linking and the question falls back to its
    // plain form whenever it needs truncating (the thread carries it in full).
    `:rotating_light: *${prefix}${linkify(clamp(input.headline, HEADLINE_MAX))}*`,
    refs.join(" · "),
    `:question: ${clamped(input.question, QUESTION_MAX) ? clamp(input.question, QUESTION_MAX) : question}`,
  ].join("\n");
  const ts = await postMessage(channel, parent);

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

  return { ts };
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
  const channel = config.slack.escalationChannel ?? "#jetta-escalations";
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
export async function notifyKbSync(headline: string, details: string[]): Promise<void> {
  const channel =
    config.slack.draftsChannel ?? config.slack.escalationChannel ?? "#jetta-escalations";
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
