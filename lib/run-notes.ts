/**
 * Keeping Jetta's private notes on a Freshdesk ticket few and short.
 *
 * Support said the notes section had become too crowded to read (2026-11-27).
 * On ticket 14850 she had written 17 of its 20 private notes against 7 public
 * messages: a suggested reply per run, a separate "what I did" note per run,
 * a copy of the live chat every few minutes, the same dev-board match twice,
 * and a shadow-triage experiment. The rules now:
 *
 *  1. One note per run. In draft mode her add_private_note calls are held
 *     (AgentResult.pendingNotes) and go under the suggested reply in the same
 *     note, as a short "What Jetta did" block. A run that ends without a draft
 *     posts them as one note instead (postRunNotes).
 *  2. A newer suggestion shrinks the older pending one to a single line
 *     (lib/drafts.ts), so one full draft is visible at a time.
 *  3. A dev-board match already noted on the ticket is not noted again.
 *  4. A running live chat keeps one note current (lib/tools/index.ts,
 *     add_to_ticket) instead of pasting the transcript each time.
 *  5. Everything except the reply itself is clipped (NOTE_LIMIT); the full
 *     text stays in the run log.
 *
 * Wording other code reads off notes is kept: "Jetta — suggested reply" opens
 * every suggestion, and the context block keeps her own phrasing, which
 * lib/performance.ts scans for hand-offs.
 */
import * as freshdesk from "./tools/freshdesk";
import type { AgentResult } from "./agent";

/** Characters of context per note. The reply itself is never clipped. */
export const NOTE_LIMIT = 600;
/** A running chat adds to its last note for this long, then starts a new one. */
export const RELAY_WINDOW_MS = 30 * 60_000;

/** Clip to the limit on a word boundary. Pure. */
export function clipNote(text: string, limit = NOTE_LIMIT): string {
  const t = text.replace(/\s+\n/g, "\n").trim();
  if (t.length <= limit) return t;
  const cut = t.slice(0, limit);
  const at = cut.lastIndexOf(" ");
  return `${(at > limit * 0.6 ? cut.slice(0, at) : cut).trimEnd()}… (full note in the run log)`;
}

const ITEM_ID = /\/pulses\/(\d{8,})|\bitem (\d{8,})\b/gi;
const MATCH_ONLY = /\b(strong|possible|likely)? ?match(ed)?\b|\bexisting (open )?dev board item\b|\balready (on|has) (a|the) dev board\b/i;
const NEW_ACTION = /\b(created|filed|opened|escalat\w*|added \+1|\+1)\b/i;

function itemIds(text: string): string[] {
  return [...text.matchAll(ITEM_ID)].map((m) => m[1] ?? m[2]!).filter(Boolean);
}

/**
 * Drop a note that only repeats a dev-board match an earlier note on the
 * ticket already gave. A note that also did something (filed, escalated,
 * +1'd) is kept whole. Pure.
 */
export function dropRepeatedMatches(notes: string[], earlierNotes: string[]): string[] {
  const seen = new Set(earlierNotes.flatMap(itemIds));
  return notes.filter((n) => {
    const ids = itemIds(n);
    if (!ids.length || !MATCH_ONLY.test(n) || NEW_ACTION.test(n)) return true;
    const fresh = ids.some((id) => !seen.has(id));
    for (const id of ids) seen.add(id);
    return fresh;
  });
}

/** The "What Jetta did" block that goes under a suggested reply. Pure. */
export function contextHtml(notes: string[]): string {
  if (!notes.length) return "";
  return `<p><b>What Jetta did</b></p>` + notes.map((n) => freshdesk.textToFdHtml(clipNote(n))).join("");
}

/** A run's notes as one standalone note, for a run that wrote no draft. Pure. */
export function standaloneNoteHtml(notes: string[]): string {
  return notes.map((n) => freshdesk.textToFdHtml(clipNote(n))).join("<hr>");
}

/** What an older suggestion becomes once a newer one is posted. Pure. */
export function supersededHtml(at: number): string {
  const when = new Date(at * 1000).toISOString().slice(0, 16).replace("T", " ");
  return `<p><b>Jetta — suggested reply (replaced)</b> <i>from ${when} UTC: a newer suggestion is further down.</i></p>`;
}

/** The rolling live-chat note. Pure. */
export function chatRelayHtml(lines: string[], conversationUrl: string): string {
  return (
    `<p><b>From the live chat, which is still running</b> · <a href="${conversationUrl}">conversation</a></p>` +
    `<ul>${lines.map((l) => `<li>${freshdesk.textToFdHtml(l).replace(/^<p>|<\/p>$/g, "")}</li>`).join("")}</ul>`
  );
}

/** Take the run's held notes; they are gone from the result afterwards. */
export function takeRunNotes(result: AgentResult): string[] {
  const notes = result.pendingNotes ?? [];
  result.pendingNotes = [];
  return notes;
}

/**
 * Post whatever notes a run held that no draft took, as one note. Call after
 * the draft step on every path that runs in draft mode. Never throws.
 */
export async function postRunNotes(ticketId: string | undefined, result: AgentResult, earlierNotes: string[] = []): Promise<void> {
  const notes = dropRepeatedMatches(takeRunNotes(result), earlierNotes);
  if (!ticketId || !notes.length) return;
  await freshdesk
    .addPrivateNote(ticketId, standaloneNoteHtml(notes), { html: true })
    .catch((e) => console.warn(`run notes on ${ticketId} failed:`, e instanceof Error ? e.message : e));
}
