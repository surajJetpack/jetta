/**
 * Closing the loop on a chat the visitor walked away from.
 *
 * Jetta answers and the visitor says nothing more. That is the commonest ending
 * on this channel and, until now, the only one with no ending at all: the
 * conversation sat in the console inbox forever, and nobody could tell the ones
 * that finished well from the ones that were dropped. Nobody watches chat
 * closely — the premise the whole channel was built on — so the inbox cannot be
 * tidied by asking the team to tidy it.
 *
 * Two halves, both driven by app/api/cron/chat-followup:
 *
 *   1. `chatFollowUpAction` — PURE. Decides, from the conversation alone,
 *      whether to nudge, resolve, or leave well alone. Pure because every
 *      interesting case is a timing case, and timing is the one thing that
 *      cannot be tested through the store: the thresholds and each skip branch
 *      are pinned in scripts/chat-contract-test.ts. Same shape as
 *      `judgeSecondTicket` in lib/chat-ticket.ts, for the same reason.
 *   2. `judgeChatFollowUp` — one model call, and only on the nudge branch. It
 *      is what lets her decide that a conversation needs no chasing at all: a
 *      visitor who said "perfect, thanks" got an answer, and asking them again
 *      whether it worked is worse than silence.
 *
 * Silence is always measured from the visitor's LAST MESSAGE, never
 * `lastActivityAt`. Her own nudge is activity, so measuring from the clock the
 * index is sorted by would reset the timer she just started and nudge the same
 * person every fifteen minutes.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { getModel } from "./llm";
import { chatBrandKey, GETSIGN_PROFILE, MAIN_PROFILE } from "./profiles";
import { transcriptText } from "./chat-store";
import type { ChatConversation } from "./types";

/** Thresholds live on the settings object; these are the shapes it must supply. */
export interface FollowUpThresholds {
  followUpMinutes: number;
  autoResolveHours: number;
}

/**
 * Why a conversation was left alone. A closed set because these are counted:
 * "how often does the sweep decide to do nothing, and for which reason" is the
 * only way to tell a well-behaved sweep from one that has quietly stopped
 * working on a channel this quiet.
 */
export type FollowUpSkip =
  | "no_visitor_message"
  | "with_a_person"
  | "waiting_for_a_person"
  | "already_resolved"
  | "her_turn"
  | "already_judged"
  | "too_recent";

/** An action that actually does something — everything but a skip. */
export type FollowUpDue =
  | { kind: "nudge"; silentMs: number }
  | { kind: "resolve"; reason: "ticketed" | "no_reply"; silentMs: number };

export type FollowUpAction = { kind: "skip"; reason: FollowUpSkip } | FollowUpDue;

/** Unix ms of the visitor's last message, or null if they never sent one. */
export function lastVisitorAt(conv: ChatConversation): number | null {
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i]!;
    if (m.author === "visitor") {
      const at = Date.parse(m.createdAt);
      return Number.isFinite(at) ? at : null;
    }
  }
  return null;
}

/**
 * What, if anything, to do about this conversation right now.
 *
 * Order matters and the early exits are the point — each one is a message that
 * must never be sent.
 */
export function chatFollowUpAction(
  conv: ChatConversation,
  now: number,
  thresholds: FollowUpThresholds,
): FollowUpAction {
  // Page-load sessions. The widget opens one on every visit, so most stored
  // conversations hold nothing; they are already hidden from the inbox and
  // there is nobody in them to talk to.
  const visitorAt = lastVisitorAt(conv);
  if (visitorAt === null) return { kind: "skip", reason: "no_visitor_message" };

  // Never speak over a colleague, and never resolve a visitor who is still
  // waiting for one. This is the handoff rule the channel already enforces in
  // chat-run.ts: she goes silent from the moment a person is ASKED for, not
  // when one arrives, because two voices answering one visitor is what makes
  // handoff feel broken.
  if (conv.status === "human") return { kind: "skip", reason: "with_a_person" };
  if (conv.status === "waiting_human") return { kind: "skip", reason: "waiting_for_a_person" };
  if (conv.status === "resolved") return { kind: "skip", reason: "already_resolved" };

  // The visitor spoke last, so SHE owes the reply — this conversation is
  // evidence of a failed turn, not of a visitor who wandered off. "Did that
  // sort it out?" on top of a question she never answered is the worst message
  // in the system, and resolving it would hide the failure. Left alone
  // deliberately: it stays in the inbox under "With Jetta", where a person can
  // see it.
  const last = conv.messages[conv.messages.length - 1];
  if (last?.author === "visitor") return { kind: "skip", reason: "her_turn" };

  const silentMs = now - visitorAt;
  const resolveAfter = Math.max(1, thresholds.autoResolveHours) * 3_600_000;
  const nudgeAfter = Math.max(1, thresholds.followUpMinutes) * 60_000;

  // Long gone. Checked before the ticket branch so a ticketed conversation
  // still finishes — it just finishes without being spoken to.
  if (silentMs >= resolveAfter) {
    return { kind: "resolve", reason: conv.ticketId ? "ticketed" : "no_reply", silentMs };
  }

  // A ticket carries the issue and a colleague will answer it by email. Chasing
  // in the chat invites the visitor to re-explain in the one place nobody is
  // reading, and risks her asking about something a colleague is halfway
  // through answering. So: no nudge, ever — only the quiet resolve above.
  if (conv.ticketId) return { kind: "skip", reason: "too_recent" };

  // One judgement per conversation, whatever it decided. See followUpAt in
  // lib/types.ts.
  if (conv.followUpAt) return { kind: "skip", reason: "already_judged" };

  if (silentMs >= nudgeAfter) return { kind: "nudge", silentMs };
  return { kind: "skip", reason: "too_recent" };
}

/**
 * The line she sends when the model is unreachable or returns nothing usable.
 *
 * Fixed text, and it has to be safe on ANY transcript the nudge branch can
 * reach — so it claims nothing about what was said, promises nothing, and
 * carries the one thing worth carrying: that replying still works.
 */
export const FOLLOW_UP_FALLBACK =
  "Just checking in — did that sort it out? " +
  "If you're still stuck, reply here and I'll pick it straight back up.";

const JUDGEMENT = z.object({
  action: z.enum(["follow_up", "resolve", "wait"]),
  message: z.string().optional(),
  reason: z.string(),
});

export type FollowUpJudgement = z.infer<typeof JUDGEMENT>;

/**
 * Read the transcript and decide how to end it.
 *
 * Pinned to the STANDARD tier for the reason chat-run.ts pins the answering
 * turn there: no human reads this before the customer does, so it is not a
 * place to save on model.
 */
export async function judgeChatFollowUp(conv: ChatConversation): Promise<FollowUpJudgement> {
  const brand = chatBrandKey(conv) === "getsign" ? GETSIGN_PROFILE.brand : MAIN_PROFILE.brand;
  const { object } = await generateObject({
    model: getModel("standard"),
    schema: JUDGEMENT,
    system: [
      `You are Jetta, the support agent for ${brand}. You answered a live chat and the customer has gone quiet.`,
      "Decide what to do with the conversation. You are choosing between three things:",
      '- "resolve": the exchange finished. They confirmed it worked, thanked you, said they would try it later, or asked something simple that you answered completely and nothing is outstanding. Closing it silently is the right ending — send no message.',
      '- "follow_up": something is genuinely unfinished. You asked them a question they never answered, gave steps nobody confirmed worked, or the problem was still open when they stopped replying. Write the message.',
      '- "wait": rare. Neither closing nor chasing is right, and a person should look at it.',
      "",
      "If you choose follow_up, `message` is the exact text sent to the customer, as a chat message:",
      "one or two sentences, plain text, no greeting and no sign-off, no markdown.",
      "State nothing about their account or the product that is not already in the transcript above —",
      "you are not looking anything up, and a guess here reaches a customer with nobody checking it.",
      "Do not promise that anyone will do anything. Do not repeat the answer you already gave.",
      "If you already asked them a question, refer to that rather than asking a new one.",
      "",
      "`reason` is for your colleagues, not the customer: one short line on why you chose this.",
    ].join("\n"),
    prompt: `Transcript:\n\n${transcriptText(conv)}`,
  });

  // A follow_up with no text is a decision the model failed to carry out. The
  // fallback line is safe on any transcript that reaches this branch, and
  // sending it beats dropping the whole judgement on the floor.
  if (object.action === "follow_up" && !object.message?.trim()) {
    return { ...object, message: FOLLOW_UP_FALLBACK };
  }
  return object;
}
