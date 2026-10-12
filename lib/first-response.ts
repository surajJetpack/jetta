/**
 * Jetta's first response on an email ticket.
 *
 * Draft mode holds every Freshdesk reply for a person, and in practice the
 * first reply a customer gets is Jetta's draft, copied by a colleague hours
 * later. This lets her send that first reply herself, on a narrow set of
 * tickets, and leaves everything after it exactly as it was.
 *
 * Which tickets: ones that arrived DIRECTLY — email, the portal, the in-app
 * support form (Freshdesk files it as "phone"), the feedback widget — and that
 * no agent has answered yet. Never a ticket that came from a chat: that
 * customer has already been talking to Jetta, and the ticket exists because
 * the chat needed a person. A second bot reply in their inbox is the
 * bot-to-bot hand-off the ticket was supposed to end.
 *
 * Four things stand between a run and a customer, in order:
 *   1. eligibility (pure, below) — channel, source, nobody has replied yet;
 *   2. hard checks on the text (pure) — the things that must never leave,
 *      whatever a model thinks of them: internal links, ticket numbers,
 *      template placeholders;
 *   3. a model gate — a second read of the reply against the customer's
 *      message and the evidence the run actually gathered. Fails CLOSED;
 *   4. a delay, announced on the ticket as a private note. A teammate who
 *      replies first, or tags the ticket `jetta-hold`, cancels it.
 * Anything stopped at 2 or 3 becomes the ordinary private-note draft, so the
 * worst case is today's behaviour.
 */
import { Redis } from "@upstash/redis";
import { generateObject } from "ai";
import { z } from "zod";
import { config } from "./config";
import { getModel } from "./llm";
import type { AgentResult } from "./agent";
import { GETSIGN_PROFILE, MAIN_PROFILE } from "./profiles";
import type { ConversationContext, Product, Ticket } from "./types";

/** Freshdesk sources a customer writes in on directly. 7 (chat) is excluded by design. */
export const DIRECT_SOURCES: Record<number, string> = {
  1: "email",
  2: "portal",
  3: "in-app form",
  9: "feedback widget",
};

/** A teammate adds this tag to a ticket to stop the scheduled reply. */
export const HOLD_TAG = "jetta-hold";

export type Eligibility = { eligible: true } | { eligible: false; reason: string };

/** May Jetta send the first public reply on this ticket? Pure. */
export function firstResponseEligibility(ctx: Pick<ConversationContext, "channel" | "ticket">): Eligibility {
  const t = ctx.ticket;
  if (ctx.channel !== "freshdesk") return { eligible: false, reason: "not_freshdesk" };
  if (!t) return { eligible: false, reason: "no_ticket" };
  if (t.source == null || !(t.source in DIRECT_SOURCES)) {
    return { eligible: false, reason: t.source === 7 ? "from_chat" : `source_${t.source ?? "unknown"}` };
  }
  // Unknown is not "no": a ticket read without this field (an older code path,
  // a stub) must not be treated as unanswered.
  if (t.hasPublicAgentReply !== false) return { eligible: false, reason: "already_answered" };
  if (t.tags?.some((tag) => tag.toLowerCase() === HOLD_TAG)) return { eligible: false, reason: "hold_tag" };
  return { eligible: true };
}

/**
 * The reply the run proposed, from its reply_to_ticket call only.
 *
 * Draft mode also rescues a reply the model wrote as final text instead of
 * calling the tool (createDraftFromRun) — that is fine when a person reads it
 * first, and not fine here, where that text is as likely to be narration.
 */
export function proposedReply(result: Pick<AgentResult, "trace">): string | null {
  const last = [...result.trace].reverse().find((t) => t.tool === "reply_to_ticket");
  const body = (last?.input as { body?: string } | undefined)?.body?.trim();
  return body || null;
}

export interface InternalRefs {
  /** Our own monday account host, e.g. "jetpackteam.monday.com". */
  mondayHost?: string;
  /** Our dev board ids. */
  boardIds: string[];
}

export function internalRefs(): InternalRefs {
  const host = /^https?:\/\/([^/]+)/.exec(config.monday.accountUrl)?.[1]?.toLowerCase();
  return {
    // The default "monday.com" names no account, so it guards nothing.
    mondayHost: host && host !== "monday.com" ? host : undefined,
    boardIds: Object.values(config.monday.boardIds).filter((v): v is string => !!v),
  };
}

/**
 * Things that never leave, whatever a model thinks of the reply. Pure.
 * Returns the reason, or null when the text is clean.
 */
export function hardBlock(body: string, internal: InternalRefs = internalRefs()): string | null {
  if (body.length < 40) return "too_short";
  if (/\bfreshdesk\.com\b|\/a\/tickets\/|\bslack\.com\b|\bvercel\.app\b/i.test(body)) return "internal_link";
  // OUR monday account and dev boards only. A customer's own board link
  // (acme.monday.com/boards/…) is a normal thing to hand back to them.
  const lower = body.toLowerCase();
  if (
    (internal.mondayHost && lower.includes(internal.mondayHost)) ||
    internal.boardIds.some((id) => new RegExp(`/boards/${id}\\b`).test(body))
  ) {
    return "internal_link";
  }
  if (/\bticket\s*#?\s*\d{4,}|#\d{5}\b/i.test(body)) return "ticket_number";
  // An unfilled template slot reaching a customer is worse than no reply.
  if (/\[(?:name|customer|your name|agent|link|url|date)[^\]]*\](?!\()|\{\{|\}\}|<[A-Z_]{3,}>|\bTODO\b|\bXXX\b/i.test(body)) {
    return "placeholder";
  }
  if (/\b(as an ai|language model|i am an ai|i'm an ai|knowledge base search)\b/i.test(body)) return "self_reference";
  if (/\b(dev(elopment)? board|monday item|private note|escalation thread|internal note)\b/i.test(body)) {
    return "internal_detail";
  }
  return null;
}

// ── formatting ─────────────────────────────────────────────────────

/**
 * A sign-off the model wrote itself, at the very end of the reply. Stripped so
 * ours is the only one — two "Best," lines is a tell no person makes.
 */
const SIGN_OFF =
  /\n+\s*(?:best(?: regards| wishes)?|kind regards|warm regards|regards|many thanks|thanks(?: again)?|thank you|cheers|sincerely|all the best)[,!.]?\s*(?:\n+\s*[^\n]{1,60}){0,3}\s*$/i;

export function stripSignOff(body: string): string {
  return body.replace(SIGN_OFF, "").trimEnd();
}

/** Requester names that are a mailbox or a role, not a person. */
const ROLE_NAME = /^(admin|administrator|support|info|team|office|accounts?|billing|sales|hello|contact|hr|it|operations|ops|no-?reply|customer|user|owner)$/i;

/**
 * Whole sentences that are pure filler, the stock lines a person skips and a
 * bot can't stop writing. The voice rules already ban most of them and the
 * model writes them anyway, so they are removed here rather than asked for
 * again. Each pattern must match a sentence that carries NO information —
 * removing it can only make the reply shorter, never wrong.
 */
const FILLER = [
  /^(that's|that is|this is) (a )?(great|good|excellent) (question|use case)[^.!?]*[.!?]$/i,
  /^(great|good|excellent) question[^.!?]*[.!?]$/i,
  /^i hope (this|my) (email|message) finds you well[.!]$/i,
  /^(thank you|thanks) (so much )?for (your patience|reaching out( to us)?|getting in touch|contacting us)[.!]$/i,
  /^(we'll|we will|i'll|i will) be in touch( shortly| soon)?[.!]$/i,
  /^i hope this (helps|clears (things|this) up)[.!]?$/i,
];

/**
 * Deterministic clean-up of the two tells prompts did not fix: a greeting to
 * "Admin", and filler sentences. Pure.
 */
export function humanize(body: string, requesterName: string | null | undefined): string {
  let out = body.trim();
  const first = requesterName?.trim().split(/\s+/)[0] ?? "";
  if (first && (ROLE_NAME.test(first) || first.includes("@"))) {
    out = out.replace(new RegExp(`^(hi|hello|hey|dear)\\s+${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[,!]?`, "i"), "Hi,");
  }
  const paras = out.split(/\n{2,}/).map((para) => {
    // Lists and multi-line blocks are left alone; filler lives in prose.
    if (para.includes("\n")) return para;
    const sentences = para.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) ?? [para];
    return sentences.filter((x) => !FILLER.some((re) => re.test(x.trim()))).join("").trim();
  });
  return paras.filter(Boolean).join("\n\n");
}

/**
 * The text that actually goes out: her reply, then a plain sign-off. Added in
 * code, not asked of the prompt, because the same prompt writes drafts that a
 * colleague sends as THEMSELVES — a "Jetta" signature there would be wrong.
 * She signs with her name, which she will also confirm is an AI if asked.
 */
export function withSignOff(body: string, brand: string): string {
  return `${stripSignOff(body)}\n\nBest,\nJetta\n${brand} Support`;
}

/**
 * The brand she signs for. Deliberately looser than profileFor(), which only
 * trusts a GetSign product it read from the ticket's own field, because it
 * narrows the KB on it. A signature is not a filter: a GetSign customer
 * whose email never set cf_product still wrote to GetSign, and signing
 * "Jetpack Apps Support" back to them is the wrong-company tell.
 */
export function signingBrand(product: Product): string {
  return product === "getsign" ? GETSIGN_PROFILE.brand : MAIN_PROFILE.brand;
}

/** Random delay in the configured window, in ms. */
export function pickDelayMs([lo, hi]: [number, number], rand = Math.random): number {
  return Math.round((lo + (hi - lo) * rand()) * 60_000);
}

// ── the model gate ─────────────────────────────────────────────────

export interface GateVerdict {
  send: boolean;
  /** For colleagues, one line. */
  reason: string;
  risk: "none" | "unsupported_claim" | "promise" | "sensitive" | "needs_person" | "misread" | "tone";
}

const VERDICT = z.object({
  send: z.boolean(),
  risk: z.enum(["none", "unsupported_claim", "promise", "sensitive", "needs_person", "misread", "tone"]),
  reason: z.string().describe("One short line for colleagues: why."),
});

/** What the run looked up and did, trimmed to what the gate needs to check claims against. */
export function evidenceFromTrace(result: Pick<AgentResult, "trace">, maxChars = 9000): string {
  const parts: string[] = [];
  for (const t of result.trace) {
    if (t.tool === "reply_to_ticket" || t.tool === "add_private_note") continue;
    const out = typeof t.result === "string" ? t.result : JSON.stringify(t.result ?? "");
    parts.push(`[${t.tool}${t.failed ? " FAILED" : ""}] ${JSON.stringify(t.input ?? {})}\n${out.slice(0, 3000)}`);
  }
  const all = parts.join("\n\n");
  return all.length > maxChars ? `${all.slice(0, maxChars)}\n[…evidence truncated]` : all || "(none — no tools were called)";
}

function customerSide(ticket: Ticket): string {
  const msgs = [
    `Subject: ${ticket.subject}`,
    ticket.description,
    ...ticket.replies.filter((r) => r.author === "customer" && !r.isPrivate).map((r) => r.body),
  ];
  return msgs.join("\n\n---\n\n").slice(0, 6000);
}

/**
 * A second read of the reply, by someone whose only job is to say no.
 * Fails CLOSED: an error, a timeout or a malformed answer is a draft, never a
 * send — a person still gets to it, exactly as today.
 */
export async function judgeFirstResponse(
  ticket: Ticket,
  reply: string,
  result: Pick<AgentResult, "trace">,
  brand: string,
): Promise<GateVerdict> {
  try {
    const { object } = await generateObject({
      model: getModel("standard"),
      schema: VERDICT,
      temperature: 0,
      system: [
        `You review a support reply for ${brand} before it is emailed to a customer with no person reading it first.`,
        "It is the FIRST reply they get. You approve it (send=true) or hold it for a colleague (send=false).",
        "",
        "Hold it if ANY of these is true:",
        "- unsupported_claim: it states a specific product fact, step, setting, price, limit or behaviour that the EVIDENCE does not support or contradicts.",
        "- promise: it says something was done that no tool in the evidence did (a refund, cancellation, discount, trial extension applied, a fix shipped, a request passed on when nothing was escalated), or commits to a date, a timeline, or an outcome.",
        "- sensitive: the customer makes a legal threat, a chargeback or payment dispute, a data-protection request (deletion, export, DPA), reports a security incident, or is abusive.",
        `- needs_person: the customer asks for a call, meeting, demo or screen-share${config.firstResponseBookingUrl ? " and the reply does not give them the booking link" : ""}; or it is a sales negotiation — haggling over price, asking for a nonprofit/education/volume discount, a custom quote, an invoice/bank-transfer arrangement, or a partnership. A colleague handles these personally. Simply asking which plan suits them, or what a plan includes, is NOT a negotiation: approve a reply that answers it from the evidence.`,
        "- misread: it answers a different question from the one asked, or ignores a main part of it.",
        "- tone: it is cold, curt, blames the customer, or reads like a form letter.",
        "",
        "These need NO evidence and are never a reason to hold: greetings, sympathy, thanks, offers of further help, asking the customer for details or a screenshot, and saying the team will look at it or get back to them when the evidence shows an escalation, dev item, or approval request of any kind (do not quibble over which team).",
        "A plain refund or cancellation REQUEST is not sensitive — approve a reply that only acknowledges it, passes it on, and promises nothing.",
        "A reply that honestly says the team is looking into it and asks for the one detail needed IS a good first reply. Do not hold a reply for being incomplete, and when in doubt about style alone, approve.",
      ].join("\n"),
      prompt: [
        "CUSTOMER'S MESSAGE(S):",
        customerSide(ticket),
        "",
        "EVIDENCE (what was looked up and done before writing the reply):",
        evidenceFromTrace(result),
        "",
        "THE REPLY:",
        reply,
      ].join("\n"),
    });
    // Belt and braces: a "send" carrying a named risk is a contradiction, and
    // a contradiction resolves to the safe side.
    return object.send && object.risk !== "none" ? { ...object, send: false } : object;
  } catch (e) {
    return { send: false, risk: "misread", reason: `gate unavailable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ── scheduled sends ────────────────────────────────────────────────

export interface ScheduledFirstResponse {
  ticketId: string;
  /** Markdown as the model wrote it, sign-off already applied. */
  body: string;
  /** Unix ms. */
  sendAt: number;
  createdAt: number;
  /**
   * Created-at of the newest customer message the reply answers. A newer one
   * at send time means the customer has said more — the reply is stale, and
   * the run for that new message decides what happens instead.
   */
  answersMessageAt: string;
  subject?: string;
  product: string;
  app?: string;
  topic?: string;
  model: string;
  toolsUsed: string[];
  resolutionSent: boolean;
  escalated: boolean;
  gateReason: string;
}

const SET = "jetta:firstresponse:due";
const key = (ticketId: string) => `jetta:firstresponse:${ticketId}`;
/** Long enough to outlive any delay and the cron's retry window. */
const TTL_SECONDS = 2 * 86400;

let redis: Redis | null = null;
function client(): Redis | null {
  if (config.kv.url && config.kv.token) {
    redis ??= new Redis({ url: config.kv.url, token: config.kv.token });
    return redis;
  }
  return null;
}
const mem = new Map<string, ScheduledFirstResponse>();

/** One per ticket: a newer schedule replaces an older one. */
export async function scheduleFirstResponse(job: ScheduledFirstResponse): Promise<void> {
  const r = client();
  if (r) {
    await r.set(key(job.ticketId), job, { ex: TTL_SECONDS });
    await r.zadd(SET, { score: job.sendAt, member: job.ticketId });
    return;
  }
  mem.set(job.ticketId, job);
}

export async function getScheduledFirstResponse(ticketId: string): Promise<ScheduledFirstResponse | null> {
  const r = client();
  if (r) return (await r.get<ScheduledFirstResponse>(key(ticketId))) ?? null;
  return mem.get(ticketId) ?? null;
}

/** Every scheduled reply, due or not, soonest first. */
export async function listScheduledFirstResponses(): Promise<ScheduledFirstResponse[]> {
  const r = client();
  if (r) {
    const ids = await r.zrange<string[]>(SET, 0, 199);
    const jobs = await Promise.all(ids.map((id) => r.get<ScheduledFirstResponse>(key(id))));
    // An index entry whose job expired is dropped from the index on the way past.
    const dead = ids.filter((_, i) => !jobs[i]);
    if (dead.length) await r.zrem(SET, ...dead).catch(() => {});
    return jobs.filter((j): j is ScheduledFirstResponse => !!j).sort((a, b) => a.sendAt - b.sendAt);
  }
  return [...mem.values()].sort((a, b) => a.sendAt - b.sendAt);
}

/**
 * Remove a job — but only the one the caller read. A newer schedule written
 * for the same ticket meanwhile (the customer wrote again) must survive.
 */
export async function clearScheduledFirstResponse(job: Pick<ScheduledFirstResponse, "ticketId" | "createdAt">): Promise<void> {
  const r = client();
  if (r) {
    const cur = await r.get<ScheduledFirstResponse>(key(job.ticketId));
    if (cur && cur.createdAt !== job.createdAt) return;
    await r.del(key(job.ticketId));
    await r.zrem(SET, job.ticketId);
    return;
  }
  const cur = mem.get(job.ticketId);
  if (!cur || cur.createdAt === job.createdAt) mem.delete(job.ticketId);
}

/** Created-at of the newest customer-authored, public message. */
export function newestCustomerMessageAt(ticket: Ticket): string {
  const last = [...ticket.replies].reverse().find((r) => r.author === "customer" && !r.isPrivate);
  return last?.createdAt ?? "";
}

export type SendDecision =
  | { action: "send" }
  | { action: "cancel"; reason: "answered" | "hold_tag" | "closed" | "customer_wrote_again" | "not_found" };

/**
 * At send time, with the ticket read fresh: is the reply still right? Pure.
 * Cancels rather than sends whenever the thread moved on without her.
 */
export function sendDecision(job: Pick<ScheduledFirstResponse, "answersMessageAt">, ticket: Ticket | null, terminal: boolean): SendDecision {
  if (!ticket) return { action: "cancel", reason: "not_found" };
  if (ticket.hasPublicAgentReply !== false) return { action: "cancel", reason: "answered" };
  if (ticket.tags?.some((t) => t.toLowerCase() === HOLD_TAG)) return { action: "cancel", reason: "hold_tag" };
  if (terminal) return { action: "cancel", reason: "closed" };
  if (newestCustomerMessageAt(ticket) > job.answersMessageAt) return { action: "cancel", reason: "customer_wrote_again" };
  return { action: "send" };
}
