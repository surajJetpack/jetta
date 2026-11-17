/**
 * Repeat problems: notice when a new ticket is the same malfunction as
 * earlier ones, and tell the developers once, on one dev item that carries
 * every ticket.
 *
 * Why not the topic label: topics are 2-4 word themes and may not quote an
 * error, so four tickets reporting "Missing recipient email address" do not
 * reliably share one. Here tickets are compared with each other directly.
 *
 * Two steps, like the fix lookup (lib/fix-lookup.ts):
 *   - `problemForTicket`, in buildContext: does this ticket describe the same
 *     malfunction as an earlier one? A word-overlap shortlist, then one model
 *     call. No shortlist, no call.
 *   - `raiseProblem`, after the run: once enough tickets share a problem,
 *     find or file its dev item, say so once on the item, add each later
 *     ticket as one line, and leave support a private note on each ticket.
 *
 * THE TICKET AGENT IS NEVER TOLD. `ctx.problem` is not rendered into the
 * prompt, so no reply can say "others have reported this" or "engineering is
 * on it" on the strength of a grouping that may be wrong.
 *
 * Enough: three different customers within 30 days, or two when one of them
 * wrote in after a fix for it was already in production (the fix did not hold).
 *
 * JETTA_REPEAT_PROBLEMS: off / shadow (group, log problems.shadow, write
 * nothing outside Jetta's own memory) / on. GetSign Freshdesk tickets only.
 */
import { createHash } from "node:crypto";
import { generateObject } from "ai";
import { z } from "zod";
import { config } from "./config";
import { logOpsEvent } from "./events";
import { words } from "./fix-lookup";
import { kvDel, kvSetNx, rateCount, rememberJettaPost } from "./kv";
import { getModel, llmKeyPresent } from "./llm";
import { log } from "./logger";
import { getProblem, getSeen, listSeen, pruneProblems, saveProblem, saveSeen, type Problem, type SeenTicket } from "./problem-store";
import * as freshdesk from "./tools/freshdesk";
import * as monday from "./tools/monday";
import type { ConversationContext, ProblemRef } from "./types";

const DAY_MS = 24 * 3600 * 1000;
/** Tickets further apart than this are not the same outbreak. */
export const PROBLEM_WINDOW_DAYS = 30;
/** Earlier tickets put to the model per new ticket. */
const SHORTLIST = 8;
/** Dev items Jetta may file for repeat problems in a day. */
const MAX_FILED_PER_DAY = 2;
/** How much of a ticket is kept and compared. */
const TEXT_KEPT = 1200;

// ── Is this the same problem as an earlier ticket? ─────────────────

export interface ShortlistedTicket {
  ticket: SeenTicket;
  shared: number;
}

/**
 * Earlier tickets that share enough distinctive words with this one to be
 * worth asking about, best first. Pure. Generous on purpose: it only decides
 * what the model sees.
 */
export function shortlistTickets(id: string, subject: string, body: string, seen: SeenTicket[], now: Date, n = SHORTLIST): ShortlistedTicket[] {
  const mine = words(`${subject}\n${body.slice(0, TEXT_KEPT)}`);
  if (mine.size < 3) return [];
  const since = new Date(now.getTime() - PROBLEM_WINDOW_DAYS * DAY_MS).toISOString();
  return seen
    .filter((t) => t.id !== id && t.at >= since)
    .map((ticket) => {
      const theirs = words(`${ticket.subject}\n${ticket.text}`);
      let shared = 0;
      for (const w of mine) if (theirs.has(w)) shared++;
      return { ticket, shared, smaller: Math.min(mine.size, theirs.size) };
    })
    .filter((x) => x.shared >= 3 && x.smaller > 0 && x.shared / x.smaller >= 0.25)
    .sort((a, b) => b.shared - a.shared)
    .slice(0, n)
    .map(({ ticket, shared }) => ({ ticket, shared }));
}

export interface Joined {
  /** The new ticket reports something broken, not a question or a request. */
  malfunction: boolean;
  /** 1-based positions in the shortlist that are the same malfunction. */
  same: { n: number; confidence: "high" | "medium" | "low" }[];
}
export type Joiner = (subject: string, body: string, short: ShortlistedTicket[]) => Promise<Joined>;

const JoinSchema = z.object({
  malfunction: z.boolean().describe("True when the new ticket reports something not working as it should."),
  same: z.array(
    z.object({
      n: z.number().describe("The earlier ticket's number, as given."),
      confidence: z.enum(["high", "medium", "low"]),
    }),
  ),
});

const JOIN_SYSTEM = `You compare support tickets about GetSign, an e-signature app inside monday.com. Decide whether a NEW ticket reports the same malfunction as any of several EARLIER tickets from other customers.

- First: is the new ticket a malfunction at all? A how-to question, a billing or account question, a feature request or a sales enquiry is not, and matches nothing.
- Two tickets are the same malfunction only when the same screen or feature fails in the same way: the same error message, or the same wrong behaviour.
- The same area is not enough. "Emails are not sent" and "emails go to the wrong address" are different malfunctions.
- "high": same error text or unmistakably the same failure. "medium": very likely the same, a detail unconfirmed. "low": a guess.
- Most tickets match nothing. An empty list is the usual, correct answer.`;

const modelJoiner: Joiner = async (subject, body, short) => {
  const prompt = [
    `NEW TICKET\n${subject}\n${body.slice(0, 2000)}`,
    "EARLIER TICKETS",
    ...short.map((s, i) => `${i + 1}. ${s.ticket.subject}\n   ${s.ticket.text.slice(0, 500).replace(/\n+/g, " ")}`),
  ].join("\n\n");
  const { object } = await generateObject({ model: getModel("standard"), schema: JoinSchema, system: JOIN_SYSTEM, prompt });
  return object;
};

export interface ProblemOptions {
  now?: Date;
  /** null: no model, so nothing is ever grouped. Word overlap alone is not evidence of the same bug. */
  join?: Joiner | null;
  /** The requester's email. Kept only as a short hash, to count customers rather than tickets. */
  requester?: string | null;
}

const whoOf = (email: string | null | undefined) =>
  email?.trim() ? createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 12) : undefined;

const refOf = (p: Problem, ticketId: string): ProblemRef => ({
  id: p.id,
  title: p.title,
  tickets: p.tickets.filter((t) => t.id !== ticketId),
  itemId: p.itemId,
  itemUrl: p.itemUrl,
});

/**
 * Record this ticket and say which problem it belongs to, if any.
 *
 * Decided once per ticket: a later message on the same ticket returns the
 * first answer, so the store is also the cache. Never throws; a lookup must
 * not stop a reply.
 */
export async function problemForTicket(ticketId: string, subject: string, body: string, opts: ProblemOptions = {}): Promise<ProblemRef | null> {
  try {
    const now = opts.now ?? new Date();
    const known = await getSeen(ticketId);
    if (known) {
      const p = known.problemId ? await getProblem(known.problemId) : null;
      return p ? refOf(p, ticketId) : null;
    }
    const me: SeenTicket = { id: ticketId, at: now.toISOString(), subject, text: body.slice(0, TEXT_KEPT), who: whoOf(opts.requester) };
    const short = shortlistTickets(ticketId, subject, body, await listSeen(), now);
    const join = opts.join !== undefined ? opts.join : llmKeyPresent() && !config.stubMode ? modelJoiner : null;
    if (!short.length || !join) {
      await saveSeen(me);
      return null;
    }
    const verdict = await join(subject, body, short);
    const matched = verdict.malfunction
      ? verdict.same.filter((s) => s.confidence !== "low").map((s) => short[s.n - 1]?.ticket).filter((t): t is SeenTicket => !!t)
      : [];
    if (!matched.length) {
      await saveSeen(me);
      return null;
    }

    // Join the problem one of them already belongs to (the biggest, if they
    // disagree), or start one from the earliest ticket.
    const existing = (await Promise.all([...new Set(matched.map((t) => t.problemId).filter((x): x is string => !!x))].map(getProblem)))
      .filter((p): p is Problem => !!p)
      .sort((a, b) => b.tickets.length - a.tickets.length)[0];
    const first = [...matched].sort((a, b) => a.at.localeCompare(b.at))[0];
    const problem: Problem = existing ?? { id: `p${first.id}`, title: first.subject, tickets: [], afterFix: [], fixes: [] };
    for (const t of [...matched, me]) {
      if (!problem.tickets.some((x) => x.id === t.id)) problem.tickets.push({ id: t.id, at: t.at, subject: t.subject, who: t.who });
      if (t.problemId !== problem.id) await saveSeen({ ...t, problemId: problem.id });
    }
    problem.tickets.sort((a, b) => a.at.localeCompare(b.at));
    await saveProblem(problem);
    await pruneProblems(now).catch(() => {});
    return refOf(problem, ticketId);
  } catch (e) {
    log.warn("problems.lookup_failed", { ticketId, error: e instanceof Error ? e.message : String(e), source: "webhook" });
    return null;
  }
}

/** Is this a run repeat problems apply to? A GetSign customer writing in on Freshdesk. */
export function problemsApply(ctx: Pick<ConversationContext, "channel" | "devEvent">, product: string): boolean {
  return config.repeatProblems !== "off" && ctx.channel === "freshdesk" && !ctx.devEvent && product === "getsign";
}

// ── When, and what, to tell people ─────────────────────────────────

/** Tickets still inside the window, oldest first. */
export function currentTickets(p: Problem, now: Date): Problem["tickets"] {
  const since = new Date(now.getTime() - PROBLEM_WINDOW_DAYS * DAY_MS).toISOString();
  return p.tickets.filter((t) => t.at >= since);
}

/**
 * How many different customers are behind those tickets. One person who
 * writes twice, or opens a second ticket to chase the first, is one customer:
 * seen in a replay of real tickets, where a "problem" of three was one person.
 * A ticket with no known requester counts as its own customer.
 */
export function customerCount(p: Problem, now: Date): number {
  return new Set(currentTickets(p, now).map((t) => t.who ?? `ticket:${t.id}`)).size;
}

/**
 * Enough customers to tell the developers? Three, or two when one of them
 * wrote in although a fix for this was already in production. Pure.
 */
export function shouldRaise(p: Problem, now: Date): boolean {
  const afterFix = currentTickets(p, now).some((t) => p.afterFix.includes(t.id));
  return customerCount(p, now) >= (afterFix ? 2 : 3);
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const ticketLine = (t: Problem["tickets"][number]) => `• ${day(t.at)}: ${t.subject.slice(0, 90)} ${freshdesk.freshdeskTicketUrl(t.id)}`;

function fixLines(p: Problem, now: Date): string[] {
  if (!p.fixes.length) return [];
  const n = currentTickets(p, now).filter((t) => p.afterFix.includes(t.id)).length;
  return [
    "",
    `${n} of these arrived after a fix for it was already in production, so the fix may not cover every case:`,
    ...p.fixes.map((f) => `• ${f.when}: ${f.summary} ${f.urls.join(" ")}`),
  ];
}

/** The first comment on the dev item. */
export function raiseText(p: Problem, now: Date): string {
  const live = currentTickets(p, now);
  return [
    `${customerCount(p, now)} customers have reported what looks like this same problem in the last ${PROBLEM_WINDOW_DAYS} days (${live.length} tickets). I grouped them from what the tickets say, so please check they are the same:`,
    ...live.map(ticketLine),
    ...fixLines(p, now),
  ].join("\n");
}

/** One more ticket on a problem already raised. */
export function addText(p: Problem, ticketId: string, now: Date): string {
  const t = p.tickets.find((x) => x.id === ticketId);
  return `Another ticket about this problem, ${currentTickets(p, now).length} in the last ${PROBLEM_WINDOW_DAYS} days:\n${t ? ticketLine(t) : freshdesk.freshdeskTicketUrl(ticketId)}`;
}

/** The private note for support on one ticket. */
export function supportProblemNote(p: Problem, ticketId: string, now: Date): string {
  const others = currentTickets(p, now).filter((t) => t.id !== ticketId);
  return [
    `Jetta: ${others.length} other ${others.length === 1 ? "ticket looks" : "tickets look"} like the same problem as this one. For support only; the customer has not been told, and the reply was written without this.`,
    "",
    ...others.map(ticketLine),
    ...(p.itemUrl ? ["", `The developers have them together on one dev item: ${p.itemUrl}`] : []),
    ...fixLines(p, now),
    "",
    "The grouping is from what the tickets say and can be wrong. Do not tell the customer how many others are affected.",
  ].join("\n");
}

/** What the system needs from monday and Freshdesk to raise a problem; a test stands in for it. */
export interface ProblemOps {
  /** The open dev item filed for a ticket, if there is one. */
  itemForTicket(ticketId: string): Promise<{ id: string; url: string } | null>;
  /** An open item that is strongly the same problem by its words. */
  searchBoard(title: string): Promise<{ id: string; url: string } | null>;
  /** File an item for the problem. Null when monday writes are off. */
  fileItem(p: Problem, description: string): Promise<{ id: string; url: string } | null>;
  /** Comment on the item as Jetta, @Developer. Returns the update id, or null when writes are off. */
  comment(itemId: string, text: string): Promise<string | null>;
  note(ticketId: string, text: string): Promise<void>;
}

const liveOps: ProblemOps = {
  async itemForTicket(ticketId) {
    const item = (await monday.devItemsForTicket(ticketId).catch(() => []))?.find((i) => i.state !== "closed");
    return item ? { id: item.id, url: item.url } : null;
  },
  async searchBoard(title) {
    const hit = (await monday.searchDevBoard(title, "getsign").catch(() => [])).find((i) => i.confidence === "strong" && i.state !== "closed");
    return hit ? { id: hit.id, url: hit.url } : null;
  },
  async fileItem(p, description) {
    const item = await monday.createDevItem({
      title: `[Repeat problem] ${p.title}`.slice(0, 200),
      product: "getsign",
      accountUrl: "(several customers: see the tickets below)",
      errorDescription: description,
      reproSteps: "Reported separately by each customer; the steps are in the linked tickets.",
      freshdeskTicketUrl: freshdesk.freshdeskTicketUrl(p.tickets[0].id),
    });
    return item.notWritten ? null : { id: item.id, url: item.url };
  },
  async comment(itemId, text) {
    const snapshot = await monday.getDevItemSnapshot(itemId).catch(() => null);
    const posted = await monday.postJettaComment(itemId, text, { mentionUserIds: (snapshot?.developers ?? []).map((d) => d.id) });
    return posted?.id ?? null;
  },
  note: (ticketId, text) => freshdesk.addPrivateNote(ticketId, text),
};

export type RaiseOutcome = "none" | "below" | "shadow" | "raised" | "added" | "already" | "writes off" | "over the cap" | "failed";

/** Do `fn` once for `key`; if it throws or reports nothing done, the marker is released so a later run can. */
async function once(key: string, fn: () => Promise<boolean>): Promise<boolean> {
  if (!(await kvSetNx(key, "1", 90 * 24 * 3600))) return false;
  try {
    if (await fn()) return true;
  } catch (e) {
    await kvDel(key).catch(() => {});
    throw e;
  }
  await kvDel(key).catch(() => {});
  return false;
}

/**
 * After a run: if this ticket's problem has enough tickets, tell the
 * developers and support. Never throws.
 */
export async function raiseProblem(ctx: ConversationContext, opts: { now?: Date; ops?: ProblemOps } = {}): Promise<RaiseOutcome> {
  const ticketId = ctx.ticket?.id;
  if (!ctx.problem || !ticketId || config.repeatProblems === "off") return "none";
  const now = opts.now ?? new Date();
  const ops = opts.ops ?? liveOps;
  try {
    const p = await getProblem(ctx.problem.id);
    if (!p) return "none";

    // A fix that was already live when this customer wrote did not stop it.
    const live = (ctx.recentFixes ?? []).filter((f) => f.state === "released");
    if (live.length) {
      if (!p.afterFix.includes(ticketId)) p.afterFix.push(ticketId);
      for (const f of live) if (!p.fixes.some((x) => x.key === f.key)) p.fixes.push({ key: f.key, summary: f.summary, when: f.when, urls: f.urls });
      await saveProblem(p);
    }
    if (!shouldRaise(p, now)) return "below";

    const first = !p.raisedAt;
    if (config.repeatProblems !== "on") {
      await logOpsEvent({
        level: "info",
        event: "problems.shadow",
        source: "webhook",
        ticketId,
        data: { problem: p.id, title: p.title, tickets: currentTickets(p, now).map((t) => t.id), afterFix: p.afterFix, would: first ? "raise" : "add", text: first ? raiseText(p, now) : addText(p, ticketId, now) },
      });
      return "shadow";
    }

    // The item that carries the problem: one a ticket already has, one on
    // the board that is plainly this, or a new one.
    if (!p.itemId) {
      let item: { id: string; url: string } | null = null;
      for (const t of p.tickets) if ((item = await ops.itemForTicket(t.id))) break;
      item ??= await ops.searchBoard(p.title);
      if (!item) {
        if ((await rateCount(`jetta:problems:filed:${now.toISOString().slice(0, 10)}`, 26 * 3600)) > MAX_FILED_PER_DAY) return "over the cap";
        item = await ops.fileItem(p, raiseText(p, now));
        if (!item) return "writes off";
      }
      p.itemId = item.id;
      p.itemUrl = item.url;
      await saveProblem(p);
    }
    const itemId = p.itemId;

    let outcome: RaiseOutcome = "already";
    const post = async (text: string) => {
      const id = await ops.comment(itemId, text);
      if (id) await rememberJettaPost(id);
      return !!id;
    };
    if (first) {
      if (await once(`jetta:problem:raised:${p.id}`, () => post(raiseText(p, now)))) {
        p.raisedAt = now.toISOString();
        p.told = currentTickets(p, now).map((t) => t.id);
        await saveProblem(p);
        outcome = "raised";
        await logOpsEvent({ level: "info", event: "problems.raised", source: "webhook", ticketId, data: { problem: p.id, itemId, tickets: currentTickets(p, now).map((t) => t.id) } });
      } else {
        return "writes off";
      }
    } else if (!p.told?.includes(ticketId) && (await once(`jetta:problem:added:${p.id}:${ticketId}`, () => post(addText(p, ticketId, now))))) {
      // Only a ticket the developers have not already been shown.
      p.told = [...(p.told ?? []), ticketId];
      await saveProblem(p);
      outcome = "added";
    }

    // Support, on each ticket that has not had the note. On the first raise
    // that is every ticket in the problem; afterwards only the new one.
    for (const t of first ? currentTickets(p, now) : [{ id: ticketId }]) {
      await once(`jetta:problem:note:${p.id}:${t.id}`, async () => {
        await ops.note(t.id, supportProblemNote(p, t.id, now));
        return true;
      }).catch((e) => log.warn("problems.note_failed", { ticketId: t.id, error: e instanceof Error ? e.message : String(e), source: "webhook" }));
    }
    return outcome;
  } catch (e) {
    log.warn("problems.raise_failed", { ticketId, error: e instanceof Error ? e.message : String(e), source: "webhook" });
    return "failed";
  }
}
