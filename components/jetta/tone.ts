/**
 * The console's one colour vocabulary.
 *
 * Four components each carried their own copy of this map — StatusChip had
 * five tones, LiveBadge had its own green and amber, Signal had four, and
 * ChatWaitingBadge hardcoded `bg-red-500` — which meant "this is fine" was a
 * different green depending on which component you happened to be looking at,
 * and a theme fix had to be made four times. Every chip, badge, dot and row
 * accent now resolves through here.
 *
 * The tokens behind these classes live in app/globals.css. Component-level
 * vocabularies (StatusChip's draft/in_review/published, Signal's on/off) stay
 * as they are — they name the domain, and each maps onto a tone here. What is
 * shared is the colour, not the naming.
 */

export type Tone =
  | "good" // succeeded, or a protective gate is engaged
  | "warn" // needs a person's attention
  | "bad" // failed, or someone is waiting
  | "info" // active and neutral — the accent, in tone clothing
  | "neutral"; // no signal; the absence of state

/** Soft wash + matching ink. The default for chips and badges. */
export const TONE_SOFT: Record<Tone, string> = {
  good: "bg-tone-good-bg text-tone-good",
  warn: "bg-tone-warn-bg text-tone-warn",
  bad: "bg-tone-bad-bg text-tone-bad",
  info: "bg-tone-info-bg text-tone-info",
  neutral: "bg-muted text-muted-foreground",
};

/**
 * Solid fill, for the one case where a count has to be seen from across the
 * room — a visitor waiting in a live chat. Reserve it; a page of solid chips
 * is a page with no emphasis.
 */
export const TONE_SOLID: Record<Tone, string> = {
  good: "bg-tone-good text-background",
  warn: "bg-tone-warn text-background",
  bad: "bg-tone-bad text-background",
  info: "bg-tone-info text-background",
  neutral: "bg-muted-foreground/25 text-muted-foreground",
};

/** Ink only, for icons sitting in ordinary text. */
export const TONE_TEXT: Record<Tone, string> = {
  good: "text-tone-good",
  warn: "text-tone-warn",
  bad: "text-tone-bad",
  info: "text-tone-info",
  neutral: "text-muted-foreground",
};

/** Shared chip geometry, so every chip in the console is the same object. */
export const CHIP_BASE =
  "inline-flex h-5 w-fit shrink-0 items-center gap-1.5 rounded-full px-2 text-[11px] font-semibold tracking-wide whitespace-nowrap";
