/**
 * Following up with a customer who went quiet on a Freshdesk ticket.
 *
 * The team already does this by hand, and it works: in a sample of 110 tickets
 * (Aug–Oct 2026) a colleague followed up on 27 of the 35 tickets with an agent
 * reply, and the customer came back after 25 of 43 follow-up chains. The
 * rhythm was always the same — a check-in about three days after the reply, a
 * nudge, then "we'll close this for now". What gave it away as a routine was
 * the wording: the same opener on every ticket, full names ("Hi Elizabeth
 * Toole"), and a close that asked about a video on tickets that never
 * mentioned one. This keeps the rhythm and writes each touch from the thread.
 *
 * Three touches, measured in business days, each landing at the hour of day
 * the customer last wrote to us (they were at their desk then):
 *   1. two business days after our reply — did the one thing we asked about work?
 *   2. three more — a different angle that makes replying easy;
 *   3. three more — a short, warm close; the ticket is resolved, and any reply
 *      reopens it.
 *
 * Any public reply from someone else restarts the count from that reply, so a
 * colleague following up by hand never collides with her. Before each touch is
 * sent it sits on the ticket as a private note for about an hour; `jetta-hold`
 * or any new message cancels it.
 *
 * Pure rules first (timing, reading the thread, checks on the text), then the
 * writer, then the per-ticket store. The cron in app/api/cron/ticket-followup
 * drives it.
 */
import { Redis } from "@upstash/redis";
import { generateObject } from "ai";
import { z } from "zod";
import { config } from "./config";
import { getModel } from "./llm";
import { HOLD_TAG, hardBlock, humanize, signingBrand, withSignOff } from "./first-response";
import type { Product } from "./types";

/** Business days before each touch: after our reply, after touch 1, after touch 2. */
export const TOUCH_GAPS = [2, 3, 3] as const;
export const MAX_TOUCHES = TOUCH_GAPS.length;
/** How long a written touch waits on the ticket as a note before it is sent. */
export const NOTE_LEAD_MINUTES: [number, number] = [50, 80];
/** When we have no idea when the customer is around: 14:00 UTC is a US morning and a European afternoon. */
const DEFAULT_ACTIVE_HOUR = 14;
const DAY = 86_400_000;

// ── timing (pure) ──────────────────────────────────────────────────

const isWeekend = (ms: number) => {
  const d = new Date(ms).getUTCDay();
  return d === 0 || d === 6;
};

/** `n` weekdays after `ms`, same time of day. Days are UTC days. */
export function addBusinessDays(ms: number, n: number): number {
  let t = ms;
  let left = n;
  while (left > 0) {
    t += DAY;
    if (!isWeekend(t)) left--;
  }
  return t;
}

/**
 * `hourUtc` (+ `jitterMinutes`) on the day `ms` falls on — so touches land
 * when the customer is about, and never on the hour like a cron job. Same
 * DAY, even when that hour is already past: a touch is sent about an hour
 * after the customer's hour (it waits on its note first), so "the next one
 * after" would push every later touch a whole day late.
 */
export function snapToActiveHour(ms: number, hourUtc: number, jitterMinutes: number): number {
  const d = new Date(ms);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hourUtc, jitterMinutes);
  while (isWeekend(t)) t += DAY;
  return t;
}

/** When touch `n` (1-based) should be written, counting from `fromMs` (our reply, or the previous touch). */
export function touchDueAt(fromMs: number, n: number, activeHourUtc: number, jitterMinutes: number): number {
  return snapToActiveHour(addBusinessDays(fromMs, TOUCH_GAPS[n - 1]), activeHourUtc, jitterMinutes);
}

/** UTC hour the customer last wrote at — the best cheap guess at when they're at their desk. */
export function activeHourOf(customerAt: string | null): number {
  const ms = customerAt ? Date.parse(customerAt) : NaN;
  return Number.isFinite(ms) ? new Date(ms).getUTCHours() : DEFAULT_ACTIVE_HOUR;
}

/** Stable 0–44 minute offset per ticket, so a recomputed due time doesn't wander between runs. */
export function jitterFor(ticketId: string, n: number): number {
  let h = n * 31;
  for (const c of ticketId) h = (h * 33 + c.charCodeAt(0)) >>> 0;
  return h % 45;
}

// ── reading the thread (pure) ──────────────────────────────────────

export interface PublicMessage {
  at: string;
  direction: "customer" | "agent";
  author: string;
  body: string;
}

/** A touch she sent, matched back to the thread by time (Freshdesk stamps it seconds after the call). */
const TOUCH_MATCH_MS = 15 * 60_000;
export const isOurTouch = (m: PublicMessage, touchTimes: string[]) =>
  m.direction === "agent" && touchTimes.some((t) => Math.abs(Date.parse(t) - Date.parse(m.at)) <= TOUCH_MATCH_MS);

export type ThreadState =
  /** The customer wrote last: the next move is ours, not a follow-up. */
  | { kind: "customer_last" }
  /** We wrote last. `anchor` is the newest reply that wasn't one of her touches. */
  | { kind: "waiting"; anchor: PublicMessage; lastCustomerAt: string | null; touchesSinceAnchor: number };

/** Where the conversation stands, from its PUBLIC messages, oldest first. */
export function readThread(messages: PublicMessage[], touchTimes: string[]): ThreadState {
  let lastCustomer = -1;
  messages.forEach((m, i) => {
    if (m.direction === "customer") lastCustomer = i;
  });
  const after = messages.slice(lastCustomer + 1);
  const anchor = [...after].reverse().find((m) => !isOurTouch(m, touchTimes));
  if (!anchor) return { kind: "customer_last" };
  return {
    kind: "waiting",
    anchor,
    lastCustomerAt: lastCustomer >= 0 ? messages[lastCustomer].at : null,
    touchesSinceAnchor: after.filter((m) => m.at > anchor.at && isOurTouch(m, touchTimes)).length,
  };
}

// ── which tickets (pure) ───────────────────────────────────────────

/** Freshdesk sources that are a conversation with a customer. 10 = outbound (e.g. review requests) is ours, not theirs. */
const OUTBOUND_SOURCE = 10;
const INTERNAL_DOMAIN = /@jetpackwork\.com>?$/i;

export type Skip = "outbound" | "internal" | "hold_tag" | "test";

/** Tickets she never follows up on, whatever the thread says. */
export function skipTicket(t: { source?: number | null; subject: string; tags?: string[]; requesterEmail?: string | null }): Skip | null {
  if (t.source === OUTBOUND_SOURCE) return "outbound";
  if (t.tags?.some((x) => x.toLowerCase() === HOLD_TAG)) return "hold_tag";
  if (/\[test\]/i.test(t.subject)) return "test";
  if (t.requesterEmail && INTERNAL_DOMAIN.test(t.requesterEmail)) return "internal";
  return null;
}

/** "Mike McArdle" → "Mike". Role mailboxes ("Admin", "support@…") get no name at all. */
export function firstNameOf(requester: string | null | undefined): string | null {
  const name = (requester ?? "").replace(/<[^>]*>/, "").trim();
  const first = name.split(/\s+/)[0] ?? "";
  if (!first || first.includes("@") || /^(admin|administrator|support|info|team|office|accounts?|billing|sales|hello|contact|hr|it|ops|operations|customer|user|owner|unknown)$/i.test(first)) {
    return null;
  }
  // "VICTONICE" is a company in caps, not a person.
  if (first.length > 3 && first === first.toUpperCase()) return null;
  return first[0].toUpperCase() + first.slice(1);
}

// ── checks on the text (pure) ──────────────────────────────────────

/** Openers the sample showed on every manual follow-up — the tell that it's a routine. */
const STOCK = /following up on (my|our|the) (previous|last|earlier)|just (checking|circling) (in|back)|touch(ing)? base|hope (this|you|your)[^.!?]*(well|finds)|gentle reminder|friendly reminder|quick nudge|bump(ing)? this/i;
const URL_RE = /https?:\/\/[^\s)<>"']+/gi;

/** Reason the text must not go out, or null. */
export function touchBlock(body: string, thread: string, previous: string[]): string | null {
  const hard = hardBlock(body);
  if (hard) return hard;
  if (STOCK.test(body)) return "stock_phrase";
  // A link she didn't get from the thread is a link she made up.
  const known = thread.toLowerCase();
  const strange = (body.match(URL_RE) ?? []).find((u) => !known.includes(u.replace(/[.,]+$/, "").toLowerCase()));
  if (strange) return "new_link";
  // The same sentence twice across touches reads as a template.
  const sentences = (s: string) => s.split(/(?<=[.!?])\s+/).map((x) => x.trim().toLowerCase()).filter((x) => x.length > 30);
  const seen = new Set(previous.flatMap(sentences));
  if (sentences(body).some((x) => seen.has(x))) return "repeats_earlier_touch";
  if (body.length > 900) return "too_long";
  return null;
}

/** The brand she signs for: the product field, else the thread itself saying GetSign. */
export function brandFor(productHint: string | null | undefined, text: string): { product: Product; brand: string } {
  const product: Product = /getsign/i.test(productHint ?? "") || /\bgetsign\b/i.test(text) ? "getsign" : "jetpackapps";
  return { product, brand: signingBrand(product) };
}

// ── the writer ─────────────────────────────────────────────────────

export type WriterDecision = "send" | "our_court" | "already_resolved" | "needs_person";

const WRITTEN = z.object({
  decision: z.enum(["send", "our_court", "already_resolved", "needs_person"]),
  waitingOn: z.string().describe("The one thing we are waiting on from the customer, in a few words. Empty if nothing."),
  reason: z.string().describe("One short line for colleagues: why this decision."),
  body: z.string().describe("The message, when decision is send. Empty otherwise."),
});
export type Written = z.infer<typeof WRITTEN>;

const TOUCH_BRIEF: Record<number, string> = {
  1: [
    "This is the FIRST follow-up. Ask about the one specific thing we are waiting on (the step we suggested, the detail we asked for) by name.",
    "Two to four short sentences. One question. Offer to help if they got stuck.",
  ].join(" "),
  2: [
    "This is the SECOND follow-up; the first got no answer. Do not repeat it. Come at it from a different angle and make answering effortless:",
    "a one-word yes/no is fine, or a screenshot of where they got to, or what they see now.",
    config.firstResponseBookingUrl ? `You may offer a quick call: ${config.firstResponseBookingUrl}` : "Do not offer a call.",
    "Two to four short sentences.",
  ].join(" "),
  3: [
    "This is the LAST follow-up. Say you'll close the ticket for now since you haven't heard back, and that replying to this email reopens it and you'll pick up exactly where things left off.",
    "Warm, no guilt, no new question, no new instructions. Two or three short sentences.",
  ].join(" "),
};

export interface WriterInput {
  touch: number;
  brand: string;
  firstName: string | null;
  subject: string;
  /** Public messages, oldest first, labelled. */
  transcript: string;
  previousTouches: string[];
  /** Name Jetta's own Freshdesk account shows as ("App Support"). */
  ownAccountName: string | null;
}

/**
 * Writes touch `n`, or decides it shouldn't be written. One model call.
 * Fails to "needs_person" — a follow-up nobody sends is today's behaviour.
 */
export async function writeTouch(input: WriterInput, rejected?: { body: string; reason: string }): Promise<Written> {
  try {
    const { object } = await generateObject({
      model: getModel("standard"),
      schema: WRITTEN,
      temperature: 0.4,
      system: [
        `You are Jetta, on the ${input.brand} support team. You are writing a follow-up email to a customer who has not replied to us.`,
        input.ownAccountName ? `Messages from "${input.ownAccountName}" in the thread were written by you.` : "",
        "If a colleague wrote the last reply, you may mention them by first name (\"the steps Cherryl sent\"). Never claim you wrote their message.",
        "",
        "First decide:",
        "- our_court: our last message says WE will do something next (look into it, check with the team, wait for a fix, get back to them), or asks nothing of the customer and leaves a question of theirs unanswered. A follow-up would be chasing them for our own homework.",
        "- already_resolved: the customer already said it works, or thanked us in a way that closes the matter.",
        "- needs_person: an angry customer, a legal threat, a chargeback or payment dispute, a pending refund or cancellation request, or anything a person should handle.",
        "- send: we answered or asked them something, and the next step is theirs.",
        "",
        `Then, for send, write the message. ${TOUCH_BRIEF[input.touch]}`,
        "",
        "Rules for the message:",
        `- Start with exactly "${input.firstName ? `Hi ${input.firstName},` : "Hi,"}" on its own line. No sign-off; it is added for you.`,
        "- Write in the language the customer wrote in.",
        "- Refer to their actual issue in their terms. Never state a product fact, step, link, price, date or promise that is not already in the thread.",
        "- Never use stock lines: \"following up on my previous message\", \"just checking in\", \"touching base\", \"I hope this finds you well\", \"friendly reminder\", \"quick nudge\". Never reuse a sentence from an earlier follow-up.",
        "- Plain text, short paragraphs, no bullet lists, no em dashes. Do not mention ticket numbers, internal notes, tools, or that you are an AI.",
      ].filter(Boolean).join("\n"),
      prompt: [
        `SUBJECT: ${input.subject}`,
        "",
        "THREAD (public messages, oldest first):",
        input.transcript,
        "",
        input.previousTouches.length
          ? `YOUR EARLIER FOLLOW-UPS ON THIS (no answer to any of them):\n${input.previousTouches.map((t, i) => `[${i + 1}] ${t}`).join("\n\n")}`
          : "No follow-ups have been sent yet.",
        rejected ? `\nYour previous attempt was rejected (${rejected.reason}). Write it again without that problem:\n${rejected.body}` : "",
      ].join("\n"),
    });
    return object;
  } catch (e) {
    return { decision: "needs_person", waitingOn: "", body: "", reason: `writer unavailable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Her greeting and filler clean-up, then her signature. */
export function finishTouch(body: string, firstName: string | null, brand: string): string {
  return withSignOff(humanize(body, firstName), brand);
}

/** Labels the thread for the writer. Long bodies are cut — the gist of each message is enough. */
export function transcriptOf(messages: PublicMessage[]): string {
  return messages
    .slice(-12)
    .map((m) => `[${m.at.slice(0, 16).replace("T", " ")} UTC] ${m.direction === "customer" ? "CUSTOMER" : `${m.author} (support)`}:\n${m.body.trim().slice(0, 1500)}`)
    .join("\n\n");
}

// ── per-ticket state ───────────────────────────────────────────────

export interface TicketFollowUp {
  ticketId: string;
  subject: string;
  /** The reply the count runs from. A newer one from anyone else restarts it. */
  anchorAt: string;
  anchorBy: string;
  touches: { n: number; sentAt: string; body: string }[];
  /** When the next touch is written (unix ms). */
  dueAt: number;
  /** Written and announced on the ticket; sent at `sendAt` unless something changes. */
  pending?: { n: number; body: string; sendAt: number; notedAt: string };
  /** She decided not to follow up from this anchor. Cleared by a new anchor. */
  stopped?: { reason: string; at: string };
  activeHourUtc: number;
  /**
   * The list endpoint's view of the ticket when last read in full. Unchanged
   * and nothing due = no need to read the thread again, which keeps a run
   * inside the Freshdesk budget it shares with live replies.
   */
  stamp: string;
  updatedAt: number;
}

const KEY = (id: string) => `jetta:ticketfollowup:${id}`;
const IDS = "jetta:ticketfollowup:ids";
/** Comfortably past the last touch (8 business days) even with a long weekend. */
const TTL_SECONDS = 21 * 86400;

let redis: Redis | null = null;
function client(): Redis | null {
  if (config.kv.url && config.kv.token) {
    redis ??= new Redis({ url: config.kv.url, token: config.kv.token });
    return redis;
  }
  return null;
}
const mem = new Map<string, TicketFollowUp>();

export async function getTicketFollowUp(ticketId: string): Promise<TicketFollowUp | null> {
  const r = client();
  if (r) return (await r.get<TicketFollowUp>(KEY(ticketId))) ?? null;
  return mem.get(ticketId) ?? null;
}

export async function saveTicketFollowUp(s: TicketFollowUp): Promise<void> {
  const r = client();
  const next = { ...s, updatedAt: Date.now() };
  if (r) {
    await r.set(KEY(s.ticketId), next, { ex: TTL_SECONDS });
    await r.sadd(IDS, s.ticketId);
    return;
  }
  mem.set(s.ticketId, next);
}

export async function clearTicketFollowUp(ticketId: string): Promise<void> {
  const r = client();
  if (r) {
    await r.del(KEY(ticketId));
    await r.srem(IDS, ticketId);
    return;
  }
  mem.delete(ticketId);
}

/** Every ticket she is following up on, soonest first. Expired entries are dropped from the index on the way past. */
export async function listTicketFollowUps(): Promise<TicketFollowUp[]> {
  const r = client();
  if (!r) return [...mem.values()].sort((a, b) => a.dueAt - b.dueAt);
  const ids = await r.smembers(IDS);
  if (!ids.length) return [];
  const all = await Promise.all(ids.map((id) => r.get<TicketFollowUp>(KEY(id))));
  const dead = ids.filter((_, i) => !all[i]);
  if (dead.length) await r.srem(IDS, ...dead).catch(() => {});
  return all.filter((s): s is TicketFollowUp => !!s).sort((a, b) => (a.pending?.sendAt ?? a.dueAt) - (b.pending?.sendAt ?? b.dueAt));
}

/**
 * Tickets read in full that turned out to need nothing (the customer wrote
 * last, or it's one she never follows up on), by the listing stamp they were
 * read at. Freshdesk's "agent responded" stat can't be trusted to mean a
 * PUBLIC reply, and without this a ticket that only looks like a candidate
 * would be re-read on every run, spending the shared Freshdesk budget on
 * nothing.
 */
const SEEN = (id: string) => `jetta:ticketfollowup:seen:${id}`;
const memSeen = new Map<string, string>();

export async function getSeenStamps(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const r = client();
  if (r) {
    const vals = await r.mget<(string | null)[]>(...ids.map(SEEN));
    ids.forEach((id, i) => {
      if (vals[i]) out.set(id, vals[i] as string);
    });
    return out;
  }
  for (const id of ids) if (memSeen.has(id)) out.set(id, memSeen.get(id)!);
  return out;
}

export async function markSeen(ticketId: string, stamp: string): Promise<void> {
  const r = client();
  if (r) {
    await r.set(SEEN(ticketId), stamp, { ex: 7 * 86400 });
    return;
  }
  memSeen.set(ticketId, stamp);
}
