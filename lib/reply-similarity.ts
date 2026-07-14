/**
 * Sent-reply vs suggested-draft similarity, for reconciling Freshdesk-native
 * draft review: when an agent replies manually, the score decides whether the
 * draft counts as approved unedited (good), approved with edits (partial), or
 * unused (bad) in the /evals learning loop.
 */
import { stripHtml } from "./tools/freshdesk";

/** score ≥ GOOD → approve-unedited; ≥ PARTIAL → approve-edited; else unused. */
export const SIMILARITY_GOOD = 0.85;
export const SIMILARITY_PARTIAL = 0.35;

export function normalizeReplyText(s: string): string {
  return stripHtml(s)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function words(s: string): string[] {
  return s.split(" ").filter(Boolean);
}

function multisetOverlap(a: string[], b: string[]): number {
  const counts = new Map<string, number>();
  for (const x of a) counts.set(x, (counts.get(x) ?? 0) + 1);
  let overlap = 0;
  for (const x of b) {
    const c = counts.get(x) ?? 0;
    if (c > 0) {
      overlap++;
      counts.set(x, c - 1);
    }
  }
  return overlap;
}

/**
 * Similarity in [0, 1] between two normalized texts: Dice coefficient over
 * word-bigram multisets (order-aware enough to distinguish edits from
 * rewrites); plain word overlap when either text is too short for bigrams.
 */
export function replySimilarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.length === 0 || wb.length === 0) return 0;
  const short = wa.length < 8 || wb.length < 8;
  const grams = (w: string[]) => (short ? w : w.slice(0, -1).map((x, i) => `${x} ${w[i + 1]}`));
  const ga = grams(wa);
  const gb = grams(wb);
  return (2 * multisetOverlap(ga, gb)) / (ga.length + gb.length);
}

export function classifyReplySimilarity(score: number): "good" | "partial" | "bad" {
  if (score >= SIMILARITY_GOOD) return "good";
  if (score >= SIMILARITY_PARTIAL) return "partial";
  return "bad";
}
