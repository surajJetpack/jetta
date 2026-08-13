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
  const prefix = input.app ? `${appLabel(input.app)} · ` : "";
  const refs = [
    link(input.freshdeskTicketUrl, input.ticketRef ?? "Ticket"),
    input.accountLabel,
    input.mondayItemUrl ? link(input.mondayItemUrl, "Dev item") : undefined,
  ].filter(Boolean);

  const parent = [
    `:rotating_light: *${prefix}${clamp(input.headline, HEADLINE_MAX)}*`,
    refs.join(" · "),
    `:question: ${clamp(input.question, QUESTION_MAX)}`,
  ].join("\n");
  const ts = await postMessage(channel, parent);

  const detail = [
    // Only repeat what the parent had to shorten — otherwise it's pure duplication.
    ...(clamped(input.question, QUESTION_MAX)
      ? [`*Question for the team*`, input.question.trim(), ""]
      : []),
    `*Issue*`,
    input.summary.trim(),
    "",
    `*Already tried*`,
    bulletize(input.alreadyTried),
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
