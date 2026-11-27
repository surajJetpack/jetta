/**
 * Ratings the team gives the console assistant's answers (👍 / 👎 in the ⌘J panel).
 *
 * The assistant keeps no transcript on the server: a voice session runs
 * browser-to-Google and only its tool calls are logged. So a rating carries
 * its own copy of the exchange (question, answer, the lookups she ran, the
 * page). Without it a 👎 would say "something was wrong" and nothing more.
 *
 * Shown on the console's Feedback page next to the dev-board comments
 * (lib/feedback.ts). A rating changes nothing about how she answers; it is
 * read by a person, who fixes the doc or the tool that misled her.
 *
 * One Redis hash, read whole, like lib/feedback.ts: a team of ten rates a
 * handful of answers a week.
 */
import { Redis } from "@upstash/redis";
import { config } from "./config";

import { ASSISTANT_FEEDBACK_REASONS, type AssistantFeedbackReason } from "./assistant-feedback-reasons";

const KEY = "jetta:assistant-feedback:v1";

export { ASSISTANT_FEEDBACK_REASONS, type AssistantFeedbackReason };

export interface AssistantFeedback {
  id: string;
  /** ISO. */
  at: string;
  author: string;
  rating: "up" | "down";
  reasons: AssistantFeedbackReason[];
  note?: string;
  /** What was asked just before the answer; empty when she spoke first. */
  question: string;
  answer: string;
  /** The lookups and page moves between the question and the answer, as the panel showed them. */
  steps: string[];
  /** The console page the person was on. */
  path?: string;
  /** "text" when the question was typed, "voice" when spoken. */
  via?: "text" | "voice";
  doneAt?: string;
  doneBy?: string;
}

const LIMITS = { question: 2000, answer: 6000, note: 2000, step: 200, steps: 20, path: 300 };

function str(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
}

/**
 * The entry a request body describes, or an error. Pure.
 * The id is the browser's, so a double click or a changed mind overwrites
 * the first rating instead of adding a second one.
 */
export function parseAssistantFeedback(body: unknown, author: string, now = new Date()): { entry: AssistantFeedback } | { error: string } {
  if (!body || typeof body !== "object") return { error: "body required" };
  const b = body as Record<string, unknown>;
  const id = str(b.id, 80);
  if (!id || !/^[\w-]+$/.test(id)) return { error: "id required" };
  if (b.rating !== "up" && b.rating !== "down") return { error: "rating must be up or down" };
  const answer = str(b.answer, LIMITS.answer);
  if (!answer) return { error: "answer required" };
  const reasons =
    b.rating === "down" && Array.isArray(b.reasons)
      ? [...new Set(b.reasons.filter((r): r is AssistantFeedbackReason => typeof r === "string" && r in ASSISTANT_FEEDBACK_REASONS))]
      : [];
  const steps = Array.isArray(b.steps)
    ? b.steps
        .map((s) => str(s, LIMITS.step))
        .filter((s): s is string => !!s)
        .slice(0, LIMITS.steps)
    : [];
  const note = str(b.note, LIMITS.note);
  const path = str(b.path, LIMITS.path);
  return {
    entry: {
      id,
      at: now.toISOString(),
      author,
      rating: b.rating,
      reasons,
      ...(note ? { note } : {}),
      question: str(b.question, LIMITS.question) ?? "",
      answer,
      steps,
      ...(path && path.startsWith("/") ? { path } : {}),
      ...(b.via === "text" || b.via === "voice" ? { via: b.via } : {}),
    },
  };
}

let redis: Redis | null = null;
function client(): Redis | null {
  if (config.kv.url && config.kv.token) {
    redis ??= new Redis({ url: config.kv.url, token: config.kv.token });
    return redis;
  }
  return null;
}
/**
 * Without Redis (tests, local dev) ratings live in memory. On globalThis,
 * because the dev server loads each route's copy of this module separately:
 * a rating saved by one route would be invisible to the Feedback page's.
 */
const mem: Map<string, AssistantFeedback> = ((
  globalThis as { __jettaAssistantFeedback?: Map<string, AssistantFeedback> }
).__jettaAssistantFeedback ??= new Map());

export async function saveAssistantFeedback(entry: AssistantFeedback): Promise<void> {
  const r = client();
  if (!r) return void mem.set(entry.id, entry);
  await r.hset(KEY, { [entry.id]: entry });
}

/** Taken back: the person clicked their rating again. */
export async function deleteAssistantFeedback(id: string, author: string): Promise<boolean> {
  const r = client();
  const found = r ? await r.hget<AssistantFeedback>(KEY, id) : mem.get(id);
  if (!found || found.author !== author) return false;
  if (r) await r.hdel(KEY, id);
  else mem.delete(id);
  return true;
}

/** Open 👎 first, then the rest; newest first inside each. */
export async function listAssistantFeedback(): Promise<AssistantFeedback[]> {
  const r = client();
  const all = r ? Object.values((await r.hgetall<Record<string, AssistantFeedback>>(KEY)) ?? {}) : [...mem.values()];
  const rank = (f: AssistantFeedback) => (f.rating === "down" && !f.doneAt ? 0 : 1);
  return all.sort((a, b) => rank(a) - rank(b) || b.at.localeCompare(a.at));
}

export async function setAssistantFeedbackDone(id: string, done: boolean, by: string): Promise<AssistantFeedback | null> {
  const r = client();
  const found = r ? await r.hget<AssistantFeedback>(KEY, id) : mem.get(id);
  if (!found) return null;
  const next: AssistantFeedback = { ...found, doneAt: done ? new Date().toISOString() : undefined, doneBy: done ? by : undefined };
  await saveAssistantFeedback(next);
  return next;
}
