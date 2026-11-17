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
 *   - `problemForTicket`, in buildContext: a light call states the ticket's
 *     symptom in one sentence (or says it is not a malfunction, and stops).
 *     Earlier symptoms that share its words are shortlisted, and one more
 *     call says which are the same malfunction. No shortlist, no second call.
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

/**
 * What a ticket is about, boiled down: tickets are compared on this, not on
 * their raw text.
 *
 * Learned from replaying real tickets. Raw text compared badly: a chat
 * transcript reaches the actual error a thousand characters in, after the
 * greetings; a follow-up email says "we keep running into this" and carries
 * the error only in its subject. One sentence naming the failure puts all of
 * them on the same footing.
 */
export interface Described {
  /** Something is not working as it should. A question, a billing matter or a request is not. */
  malfunction: boolean;
  /** What fails and how, one sentence, any error message quoted word for word. */
  symptom: string;
}
export type Describer = (subject: string, body: string) => Promise<Described>;

const DescribeSchema = z.object({
  malfunction: z.boolean().describe("True when the customer reports something not working as it should."),
  symptom: z.string().describe("One sentence: which screen or feature fails and how. Quote any error message exactly. Empty when not a malfunction."),
});

const DESCRIBE_SYSTEM = `You read one support ticket about GetSign, an e-signature app inside monday.com, and state the problem in it.

- malfunction: true only when something is not working as it should. A how-to question, a billing or account question, a feature request, a sales enquiry or a thank-you is false.
- symptom: ONE sentence naming the screen or feature and what goes wrong, as a developer would file it. If the customer quotes an error message, quote it exactly, in double quotes. The subject line counts: a reply that only says "still happening" takes its symptom from the subject.
- No names, companies, emails, account or board numbers.
- A chat transcript includes the assistant's own lines; describe the CUSTOMER's problem.`;

const modelDescriber: Describer = async (subject, body) => {
  const { object } = await generateObject({
    model: getModel("light"),
    schema: DescribeSchema,
    system: DESCRIBE_SYSTEM,
    prompt: `SUBJECT: ${subject}\n\n${body.slice(0, 4000)}`,
  });
  return { malfunction: object.malfunction && !!object.symptom.trim(), symptom: object.symptom.trim() };
};

export interface ShortlistedTicket {
  ticket: SeenTicket;
  shared: number;
}

/**
 * Earlier malfunctions whose symptom shares distinctive words with this one,
 * best first. Pure. Generous on purpose: it only decides what the model sees.
 */
export function shortlistTickets(id: string, symptom: string, seen: SeenTicket[], now: Date, n = SHORTLIST): ShortlistedTicket[] {
  const mine = words(symptom);
  if (mine.size < 2) return [];
  const since = new Date(now.getTime() - PROBLEM_WINDOW_DAYS * DAY_MS).toISOString();
  return seen
    .filter((t) => t.id !== id && t.at >= since && !!t.symptom)
    .map((ticket) => {
      const theirs = words(ticket.symptom!);
      let shared = 0;
      for (const w of mine) if (theirs.has(w)) shared++;
      return { ticket, shared, smaller: Math.min(mine.size, theirs.size) };
    })
    .filter((x) => x.shared >= 2 && x.smaller > 0 && x.shared / x.smaller >= 0.3)
    .sort((a, b) => b.shared - a.shared)
    .slice(0, n)
    .map(({ ticket, shared }) => ({ ticket, shared }));
}

export interface Joined {
  /** 1-based positions in the shortlist that are the same malfunction. */
  same: { n: number; confidence: "high" | "medium" | "low" }[];
}
export type Joiner = (symptom: string, body: string, short: ShortlistedTicket[]) => Promise<Joined>;

const JoinSchema = z.object({
  same: z.array(
    z.object({
      n: z.number().describe("The earlier report's number, as given."),
      confidence: z.enum(["high", "medium", "low"]),
    }),
  ),
});

const JOIN_SYSTEM = `You compare bug reports about GetSign, an e-signature app inside monday.com. A NEW report has come in. Decide which EARLIER reports, from other customers, are the same underlying malfunction: one a developer would fix with one change.

- Same malfunction: the same feature fails in the same way. The wording will differ between customers, and so can the exact error text: "Missing recipient email address" and "No recipient found for this document", both when sending, are one failure seen twice.
- Not the same: a different feature, or the same feature failing differently. "Emails are not sent" and "emails go to the wrong address" are two bugs. So are "the editor never loads" and "the editor loads but a field is missing".
- "high": unmistakably the same failure. "medium": very likely the same, a detail unconfirmed. "low": the same area only, or a guess.
- Many reports match nothing. An empty list is a normal answer.`;

const modelJoiner: Joiner = async (symptom, body, short) => {
  const prompt = [
    `NEW REPORT\n${symptom}\n\nFrom the ticket:\n${body.slice(0, 1200)}`,
    "EARLIER REPORTS",
    ...short.map((s, i) => `${i + 1}. ${s.ticket.symptom}\n   (ticket subject: ${s.ticket.subject.slice(0, 120)})`),
  ].join("\n\n");
  const { object } = await generateObject({ model: getModel("standard"), schema: JoinSchema, system: JOIN_SYSTEM, prompt });
  return object;
};

export interface ProblemOptions {
  now?: Date;
  /** null: no model, so nothing is ever grouped. Word overlap alone is not evidence of the same bug. */
  join?: Joiner | null;
  /** null: no model, so no ticket has a symptom to compare. */
  describe?: Describer | null;
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
    const useModel = llmKeyPresent() && !config.stubMode;
    const describe = opts.describe !== undefined ? opts.describe : useModel ? modelDescriber : null;
    const join = opts.join !== undefined ? opts.join : useModel ? modelJoiner : null;
    // Recorded before anything can fail, so a ticket is only ever described once.
    await saveSeen(me);
    if (!describe || !join) return null;
    const said = await describe(subject, body);
    if (!said.malfunction) return null;
    me.symptom = said.symptom;
    await saveSeen(me);
    const short = shortlistTickets(ticketId, me.symptom, await listSeen(), now);
    if (!short.length) return null;
    const verdict = await join(me.symptom, body, short);
    const matched = verdict.same.filter((s) => s.confidence !== "low").map((s) => short[s.n - 1]?.ticket).filter((t): t is SeenTicket => !!t);
    if (!matched.length) return null;

    // Join the problem most of the matched tickets already belong to, or
    // start one from the earliest ticket. A ticket that is already in a
    // DIFFERENT problem stays there: one new ticket resembling both is not
    // reason enough to fuse two problems, and in a replay of real tickets
    // that chaining turned "the editor is slow" and "a field is missing" into
    // one sprawling group.
    const votes = new Map<string, number>();
    for (const t of matched) if (t.problemId) votes.set(t.problemId, (votes.get(t.problemId) ?? 0) + 1);
    const candidates = (await Promise.all([...votes.keys()].map(getProblem))).filter((p): p is Problem => !!p);
    const existing = candidates.sort((a, b) => (votes.get(b.id) ?? 0) - (votes.get(a.id) ?? 0) || b.tickets.length - a.tickets.length)[0];
    const first = [...matched].sort((a, b) => a.at.localeCompare(b.at))[0];
    const problem: Problem = existing ?? { id: `p${first.id}`, title: first.subject, tickets: [], afterFix: [], fixes: [] };
    for (const t of [...matched, me]) {
      if (t.problemId && t.problemId !== problem.id) continue;
      if (!problem.tickets.some((x) => x.id === t.id)) problem.tickets.push({ id: t.id, at: t.at, subject: t.subject, who: t.who, symptom: t.symptom });
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
/** The symptom when there is one: it is what lets a developer see at a glance whether a ticket belongs. */
const ticketLine = (t: Problem["tickets"][number]) => `• ${day(t.at)}: ${(t.symptom || t.subject).slice(0, 180)} ${freshdesk.freshdeskTicketUrl(t.id)}`;

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
