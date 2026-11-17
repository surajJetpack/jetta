/**
 * Has this already been fixed? When a GetSign ticket arrives, check it
 * against what the developers have fixed lately (lib/fix-store.ts, filled by
 * the release watcher).
 *
 * Two readers, both internal:
 *   - support, in one private note on the ticket: what was fixed, whether it
 *     is in production or waiting for a release, and the link;
 *   - the developer, on the dev item Jetta files: the recent changes in the
 *     same area, so a bug a release caused arrives with its likely cause.
 *
 * THE TICKET AGENT NEVER SEES A FINDING. `ctx.recentFixes` is not rendered
 * into the prompt and no tool returns it, the same arrangement as the log and
 * Sentry evidence. So the reply cannot tell a customer "this was fixed" on a
 * guess: the model that writes the reply was never told. Whether to tell the
 * customer is a person's call, from the note.
 *
 * JETTA_FIX_LOOKUP: off / shadow (look up, log fixlookup.shadow, write
 * nothing) / on. GetSign Freshdesk tickets only.
 */
import { createHash } from "node:crypto";
import { generateObject } from "ai";
import { z } from "zod";
import { config } from "./config";
import { logOpsEvent } from "./events";
import { listFixes, type ShippedFix } from "./fix-store";
import { kvDel, kvGet, kvSet, kvSetNx } from "./kv";
import { getModel, llmKeyPresent } from "./llm";
import { log } from "./logger";
import * as freshdesk from "./tools/freshdesk";
import type { ConversationContext, RelatedFix } from "./types";

const DAY_MS = 24 * 3600 * 1000;
/** A ticket this soon after a release that touched the same thing may be that release's doing. */
export const REGRESSION_DAYS = 14;
/** Fixes put to the model per ticket. */
const SHORTLIST = 6;

// ── Shortlist (pure) ───────────────────────────────────────────────

/**
 * Words that say nothing about WHICH GetSign problem this is: every ticket
 * and every fix has them.
 */
const COMMON = new Set(
  (
    "the and for with that this from have has had not but are was were can cannot could would should will when where what " +
    "which who how why does did done into onto over under after before then than them they their there here been being " +
    "about also just only some any all our your you its it's i'm we're please thanks thank hello dear regards team help " +
    "getsign monday board item items document documents sign signing signed signature signatures app application issue " +
    "issues problem problems error errors working work works worked use using used user users customer customers need " +
    "needs want wants still again new now get got make made show shows showing shown fix fixes fixed stop stops " +
    "let lets able unable trying try tried see seen know like"
  ).split(" "),
);

/** Distinctive words: lowercased, three letters or more, common words dropped, a trailing plural "s" removed. */
export function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || COMMON.has(raw)) continue;
    const w = raw.length > 3 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw;
    if (!COMMON.has(w)) out.add(w);
  }
  return out;
}

export interface Shortlisted {
  fix: ShippedFix;
  /** Distinctive words of the fix found in the ticket. */
  shared: number;
  /** That, as a share of the fix's distinctive words. */
  coverage: number;
}

/**
 * The fixes whose words turn up in the ticket, best first.
 *
 * Deliberately generous: it only decides what the model is asked about. Two
 * shared distinctive words and a third of the fix's vocabulary is a lead.
 */
export function shortlistFixes(subject: string, body: string, fixes: ShippedFix[], n = SHORTLIST): Shortlisted[] {
  const ticket = words(`${subject}\n${body}`);
  if (ticket.size < 2) return [];
  return fixes
    .filter((f) => f.customerVisible)
    .map((fix) => {
      const w = words(`${fix.summary} ${fix.title}`);
      let shared = 0;
      for (const x of w) if (ticket.has(x)) shared++;
      return { fix, shared, coverage: w.size ? shared / w.size : 0 };
    })
    .filter((x) => x.shared >= 2 && x.coverage >= 0.34)
    .sort((a, b) => b.coverage - a.coverage || b.shared - a.shared)
    .slice(0, n);
}

/** Word overlap strong enough to mention with no model to confirm it. */
const strongOverlap = (s: Shortlisted) => s.shared >= 4 && s.coverage >= 0.6;

// ── Confirmation ───────────────────────────────────────────────────

export interface Confirmed {
  /** 1-based position in the shortlist. */
  n: number;
  confidence: "high" | "medium" | "low";
  reason: string;
}
export type Confirmer = (subject: string, body: string, short: Shortlisted[]) => Promise<Confirmed[]>;

const ConfirmSchema = z.object({
  matches: z.array(
    z.object({
      n: z.number().describe("The change's number, as given."),
      confidence: z.enum(["high", "medium", "low"]),
      reason: z.string().describe("One sentence: what in the ticket matches what the change did."),
    }),
  ),
});

const CONFIRM_SYSTEM = `A customer has written to support about GetSign, an e-signature app inside monday.com. Below are changes the developers made recently. Decide which of them, if any, are about the SAME problem the customer describes.

- A change counts only when it addresses the specific symptom in the ticket: the same screen or feature AND the same thing going wrong.
- The same area is not enough. A ticket about emails not arriving and a change to email wording are different things.
- "high": the change describes exactly what the customer reports. "medium": very likely the same, a detail unconfirmed. "low": a guess.
- Most tickets match nothing. An empty list is the usual, correct answer.
- A how-to question, a billing question or a feature request matches nothing.`;

const modelConfirmer: Confirmer = async (subject, body, short) => {
  const prompt = [
    `THE TICKET\n${subject}\n${body.slice(0, 2500)}`,
    "RECENT CHANGES",
    ...short.map((s, i) => `${i + 1}. ${s.fix.summary}\n   ${s.fix.body.slice(0, 400).replace(/\n+/g, " ") || s.fix.title}`),
  ].join("\n\n");
  const { object } = await generateObject({ model: getModel("standard"), schema: ConfirmSchema, system: CONFIRM_SYSTEM, prompt });
  return object.matches;
};

// ── The lookup ─────────────────────────────────────────────────────

const dateLabel = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

function toRelated(fix: ShippedFix, confidence: RelatedFix["confidence"], reason: string, now: Date): RelatedFix {
  const released = fix.state === "released" && fix.releasedAt ? fix.releasedAt : undefined;
  return {
    key: fix.key,
    summary: fix.summary,
    state: fix.state,
    when: dateLabel(released ?? fix.mergedAt),
    urls: fix.prs.map((p) => p.url),
    confidence,
    reason,
    recent: !!released && now.getTime() - new Date(released).getTime() <= REGRESSION_DAYS * DAY_MS,
  };
}

export interface LookupOptions {
  now?: Date;
  fixes?: ShippedFix[];
  /** null: no model; only a strong word overlap is reported, as "possible". */
  confirm?: Confirmer | null;
}

/** Recent fixes that are about the problem in this ticket. Usually none. Never throws. */
export async function relatedFixes(subject: string, body: string, opts: LookupOptions = {}): Promise<RelatedFix[]> {
  try {
    const now = opts.now ?? new Date();
    const short = shortlistFixes(subject, body, opts.fixes ?? (await listFixes()));
    if (!short.length) return [];
    const confirm = opts.confirm !== undefined ? opts.confirm : llmKeyPresent() ? modelConfirmer : null;
    if (!confirm) {
      return short.filter(strongOverlap).slice(0, 2).map((s) => toRelated(s.fix, "possible", `Shares ${s.shared} distinctive words with the ticket.`, now));
    }
    const out: RelatedFix[] = [];
    for (const m of await confirm(subject, body, short)) {
      const hit = short[m.n - 1];
      if (!hit || m.confidence === "low" || out.some((o) => o.key === hit.fix.key)) continue;
      out.push(toRelated(hit.fix, m.confidence, m.reason.trim(), now));
    }
    return out.slice(0, 3);
  } catch (e) {
    log.warn("fixlookup.failed", { error: e instanceof Error ? e.message : String(e), source: "webhook" });
    return [];
  }
}

/**
 * The lookup for one ticket, remembered for a few hours.
 *
 * `buildContext` runs for more than the webhook (the follow-up crons, the
 * first-reply send, the test page), and each would otherwise pay for the same
 * model call. Keyed on the text, so a new customer message looks again.
 */
export async function lookupForTicket(ticketId: string, subject: string, body: string, opts: LookupOptions = {}): Promise<RelatedFix[]> {
  const key = `jetta:fixlookup:${ticketId}:${createHash("sha256").update(`${subject}\n${body}`).digest("hex").slice(0, 16)}`;
  try {
    const cached = await kvGet(key);
    if (cached) return (typeof cached === "string" ? JSON.parse(cached) : cached) as RelatedFix[];
  } catch {
    // An unreadable cache is a miss.
  }
  const found = await relatedFixes(subject, body, opts);
  await kvSet(key, JSON.stringify(found), 6 * 3600).catch(() => {});
  return found;
}

/** Is this a run the lookup applies to? GetSign, a Freshdesk ticket, started by the customer. */
export function lookupApplies(ctx: Pick<ConversationContext, "channel" | "devEvent">, product: string): boolean {
  return config.fixLookup !== "off" && ctx.channel === "freshdesk" && !ctx.devEvent && product === "getsign";
}

// ── What gets written ──────────────────────────────────────────────

const stateLine = (f: RelatedFix) => (f.state === "released" ? `In production since ${f.when}` : `Merged ${f.when}, not yet released`);
const sure = (f: RelatedFix) => (f.confidence === "high" ? "Likely" : "Possibly");

/** The private note for support. Plain text; Freshdesk converts it. */
export function supportNote(fixes: RelatedFix[]): string {
  return [
    "Jetta: recent changes that may be about this ticket. For support only; the customer has not been told, and the reply was written without this.",
    "",
    ...fixes.flatMap((f) => [
      `• ${stateLine(f)}: ${f.summary}`,
      `  ${sure(f)} related. ${f.reason}`,
      ...(f.recent ? [`  Shipped within the last ${REGRESSION_DAYS} days: if the customer's problem started around ${f.when}, this change may have caused it.`] : []),
      `  ${f.urls.join("  ")}`,
    ]),
    "",
    // Learned from replaying real tickets: a customer who writes AFTER a fix
    // reached production still has the problem, so "try again" is the wrong
    // advice. The fix missed their case, or it is what broke things.
    "A change that was already in production when the customer wrote did not stop their problem: it may not cover their case, or it may have caused it. " +
      "Give the developers this link rather than asking the customer to retry. " +
      "A change not yet released ships with the next release; do not give the customer a date.",
  ].join("\n");
}

/** The same findings for the developer, on the dev item. Null when there is nothing to add. */
export function devEvidence(fixes: RelatedFix[] | undefined): string | null {
  if (!fixes?.length) return null;
  return fixes
    .map((f) =>
      [
        f.recent ? `Possibly related to the ${f.when} release: ${f.summary}` : `${stateLine(f)}: ${f.summary}`,
        `${sure(f)} related. ${f.reason}`,
        f.urls.join("  "),
      ].join("\n"),
    )
    .join("\n\n");
}

/**
 * After a run: tell support what the lookup found, once per ticket per fix.
 * Returns what happened, for the run's record. Never throws.
 */
export async function noteRelatedFixes(ctx: ConversationContext): Promise<"none" | "shadow" | "noted" | "already noted" | "failed"> {
  const fixes = ctx.recentFixes ?? [];
  const ticketId = ctx.ticket?.id;
  if (!fixes.length || !ticketId || config.fixLookup === "off") return "none";
  const data = { fixes: fixes.map((f) => ({ key: f.key, state: f.state, confidence: f.confidence, recent: f.recent, reason: f.reason })) };
  if (config.fixLookup !== "on") {
    await logOpsEvent({ level: "info", event: "fixlookup.shadow", source: "webhook", ticketId, data: { ...data, note: supportNote(fixes) } });
    return "shadow";
  }
  // A customer's second and third message must not repeat the note.
  const fresh: RelatedFix[] = [];
  for (const f of fixes) if (await kvSetNx(markerKey(ticketId, f.key), "1", 90 * 24 * 3600)) fresh.push(f);
  if (!fresh.length) return "already noted";
  try {
    await freshdesk.addPrivateNote(ticketId, supportNote(fresh));
    await logOpsEvent({ level: "info", event: "fixlookup.noted", source: "webhook", ticketId, data });
    return "noted";
  } catch (e) {
    for (const f of fresh) await kvDel(markerKey(ticketId, f.key)).catch(() => {});
    log.warn("fixlookup.note_failed", { ticketId, error: e instanceof Error ? e.message : String(e), source: "webhook" });
    return "failed";
  }
}
const markerKey = (ticketId: string, key: string) => `jetta:fixnote:${ticketId}:${key}`;
