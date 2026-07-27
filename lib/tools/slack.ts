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

export interface EscalationInput {
  freshdeskTicketUrl: string;
  userAccountUrl: string;
  /** Dev board item URL, when create_dev_item/add_plus_one ran earlier this turn. Internal channel only. */
  mondayItemUrl?: string;
  /** One-paragraph summary of the issue. */
  summary: string;
  /** What Jetta already tried. */
  alreadyTried: string;
  /** A specific question for the dev team. */
  question: string;
}

/** Post a fully-formed escalation to #jetta-escalations. */
export async function sendEscalation(input: EscalationInput): Promise<{ ts: string }> {
  const channel = config.slack.escalationChannel ?? "#jetta-escalations";
  const text = [
    `:rotating_light: *Escalation from Jetta*`,
    `*Ticket:* ${input.freshdeskTicketUrl}`,
    `*Account:* ${input.userAccountUrl}`,
    ...(input.mondayItemUrl ? [`*Dev board item:* ${input.mondayItemUrl}`] : []),
    "",
    `*Issue:* ${input.summary}`,
    `*Already tried:* ${input.alreadyTried}`,
    `*Question for the team:* ${input.question}`,
  ].join("\n");
  const ts = await postMessage(channel, text);
  return { ts };
}

export interface MonetApprovalRequest {
  id: string;
  action: "trial" | "discount";
  app: string;
  accountSlug: string;
  /** Human-readable summary of what will happen, e.g. "set trial to 20 days". */
  summary: string;
  ticketUrl?: string;
}

/**
 * Post a trial/discount approval request to the escalation channel, WITH the
 * exact Slack commands to approve or reject. A human runs one of them; the
 * approve path then executes the monday call.
 */
export async function requestMonetApproval(req: MonetApprovalRequest): Promise<{ ts: string }> {
  const channel = config.slack.escalationChannel ?? "#jetta-escalations";
  const icon = req.action === "trial" ? ":hourglass_flowing_sand:" : ":money_with_wings:";
  const text = [
    `${icon} *Approval needed — ${req.app} ${req.action}*  (ref \`${req.id}\`)`,
    req.ticketUrl ? `*Ticket:* ${req.ticketUrl}` : `_Requested by Jetta_`,
    `*Account:* \`${req.accountSlug}\``,
    `*Action:* ${req.summary}`,
    "",
    `*To approve* — reply in this channel:  \`@Jetta approve monet ${req.id}\``,
    `*To reject* — reply:  \`@Jetta reject monet ${req.id}\``,
    `_Nothing happens on monday until an admin approves. This request expires in 3 days._`,
  ].join("\n");
  const ts = await postMessage(channel, text);
  return { ts };
}

/** Ping the team that a Jetta draft reply is waiting for review (draft mode). */
export async function notifyDraftPending(input: {
  subject: string;
  ticketUrl: string;
  consoleUrl: string;
}): Promise<void> {
  const channel =
    config.slack.draftsChannel ?? config.slack.escalationChannel ?? "#jetta-escalations";
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

/** Daily KB-sync summary — posted only when something changed or was flagged. */
export async function notifyKbSync(lines: string[]): Promise<void> {
  const channel =
    config.slack.draftsChannel ?? config.slack.escalationChannel ?? "#jetta-escalations";
  await postMessage(channel, [`:books: *KB sync*`, ...lines].join("\n"));
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
