/**
 * Draft evaluations + learned guidelines — the feedback loop behind /evals.
 *
 * Every draft decision (approve/discard in the drafts console) records a
 * ReplyEvaluation: a derived rating, optional reason tags and note, and a
 * snapshot of the suggested vs sent reply. A batch distiller (lib/distill.ts)
 * turns evaluations into candidate Learnings; a human approves them in /evals;
 * only approved learnings are injected into the system prompt.
 *
 * Storage mirrors the reply-draft pattern in lib/kv.ts: per-id Redis key +
 * set index, with a single-process in-memory fallback for stub/local runs.
 */
import { Redis } from "@upstash/redis";
import { config } from "./config";

// ── Types ──────────────────────────────────────────────────────────

/** Derived from the reviewer's action — never asked for explicitly. */
export type EvalRating = "good" | "partial" | "bad";

/**
 * Reason tags. First six reuse the human-benchmark "why human won" taxonomy
 * so console feedback and retrospective benchmarks speak the same language.
 */
export const EVAL_TAGS = [
  "product-knowledge-gap",
  "account-context",
  "authority",
  "judgment-call",
  "tone",
  "conciseness",
  "wrong-action",
  "policy",
  "other",
] as const;
export type EvalTag = (typeof EVAL_TAGS)[number];

export interface ReplyEvaluation {
  /** Same as the draft id — one evaluation per decided draft, idempotent. */
  id: string;
  ticketId: string;
  subject?: string;
  channel: "freshdesk" | "freshchat";
  product: string;
  model?: string;
  decidedBy: string;
  /** Unix seconds of the decision. */
  at: number;
  action: "approve" | "discard";
  /** approve-unedited = good, approve-edited = partial, discard = bad. */
  rating: EvalRating;
  tags: EvalTag[];
  note?: string;
  /** Snapshots — drafts expire after 30d, evaluations live 180d. */
  suggestedReply: string;
  /** What was actually sent (approve only). */
  finalBody?: string;
  /** Set once a distill batch has consumed this evaluation. */
  distilled?: boolean;
  /** Learnings this evaluation contributed to (provenance forward-link). */
  learningIds?: string[];
}

export type LearningState = "candidate" | "approved" | "rejected" | "retired";
export type LearningProduct = "getsign" | "jetpackapps" | "all";

export interface Learning {
  id: string;
  /** One imperative behavioral rule, clamped to ≤300 chars at write time. */
  text: string;
  category: EvalTag;
  product: LearningProduct;
  /**
   * candidate → approved | rejected; approved → retired.
   * rejected/retired learnings are kept so the distiller never re-proposes them.
   */
  state: LearningState;
  createdAt: number;
  updatedAt: number;
  /** Console username that approved/rejected/retired it. */
  decidedBy?: string;
  /** Evaluations that spawned or reinforced this learning. */
  sourceEvalIds: string[];
  /** How many distill batches re-confirmed this rule — drives injection order. */
  reinforcedCount: number;
  /** Set on a "revise" candidate — approving it retires the referenced learning. */
  supersedes?: string;
  /** Distiller's one-line justification, shown on the review card. */
  rationale?: string;
}

export const MAX_LEARNING_CHARS = 300;

// ── Redis / in-memory plumbing (same shape as lib/kv.ts) ───────────

const EVAL_IDS = "jetta:evals:ids";
const EVAL_UNDISTILLED = "jetta:evals:undistilled";
const evalKey = (id: string) => `jetta:eval:${id}`;
const EVAL_TTL = 180 * 86400;

const LEARNING_IDS = "jetta:learnings:ids";
const learningKey = (id: string) => `jetta:learning:${id}`;

let redis: Redis | null = null;
function client(): Redis | null {
  if (config.kv.url && config.kv.token) {
    redis ??= new Redis({ url: config.kv.url, token: config.kv.token });
    return redis;
  }
  return null;
}

const memEvals = new Map<string, ReplyEvaluation>();
const memUndistilled = new Set<string>();
const memLearnings = new Map<string, Learning>();

// ── Evaluations ────────────────────────────────────────────────────

export async function recordEvaluation(ev: ReplyEvaluation): Promise<void> {
  const r = client();
  if (r) {
    await r.set(evalKey(ev.id), ev, { ex: EVAL_TTL });
    await r.sadd(EVAL_IDS, ev.id);
    if (!ev.distilled) await r.sadd(EVAL_UNDISTILLED, ev.id);
    return;
  }
  memEvals.set(ev.id, ev);
  if (!ev.distilled) memUndistilled.add(ev.id);
}

export async function getEvaluation(id: string): Promise<ReplyEvaluation | null> {
  const r = client();
  if (r) return await r.get<ReplyEvaluation>(evalKey(id));
  return memEvals.get(id) ?? null;
}

/** All evaluations, newest first. Opportunistically prunes expired index ids. */
export async function listEvaluations(): Promise<ReplyEvaluation[]> {
  const r = client();
  if (r) {
    const ids = await r.smembers(EVAL_IDS);
    if (!ids.length) return [];
    const raw = await Promise.all(ids.map((id) => r.get<ReplyEvaluation>(evalKey(id))));
    const live: ReplyEvaluation[] = [];
    for (let i = 0; i < ids.length; i++) {
      if (raw[i]) live.push(raw[i]!);
      else {
        await r.srem(EVAL_IDS, ids[i]);
        await r.srem(EVAL_UNDISTILLED, ids[i]);
      }
    }
    return live.sort((a, b) => b.at - a.at);
  }
  return [...memEvals.values()].sort((a, b) => b.at - a.at);
}

/** Evaluations not yet consumed by a distill batch, oldest first. */
export async function getUndistilledEvaluations(): Promise<ReplyEvaluation[]> {
  const r = client();
  if (r) {
    const ids = await r.smembers(EVAL_UNDISTILLED);
    if (!ids.length) return [];
    const raw = await Promise.all(ids.map((id) => r.get<ReplyEvaluation>(evalKey(id))));
    const live: ReplyEvaluation[] = [];
    for (let i = 0; i < ids.length; i++) {
      if (raw[i]) live.push(raw[i]!);
      else await r.srem(EVAL_UNDISTILLED, ids[i]);
    }
    return live.sort((a, b) => a.at - b.at);
  }
  return [...memUndistilled]
    .map((id) => memEvals.get(id))
    .filter((e): e is ReplyEvaluation => !!e)
    .sort((a, b) => a.at - b.at);
}

/** Mark evaluations as consumed and link them to the learnings they fed. */
export async function markDistilled(
  evalIds: string[],
  learningIdsByEval: Map<string, string[]>,
): Promise<void> {
  const r = client();
  for (const id of evalIds) {
    const ev = await getEvaluation(id);
    if (ev) {
      const linked = learningIdsByEval.get(id) ?? [];
      const next: ReplyEvaluation = {
        ...ev,
        distilled: true,
        learningIds: [...new Set([...(ev.learningIds ?? []), ...linked])],
      };
      if (r) await r.set(evalKey(id), next, { ex: EVAL_TTL });
      else memEvals.set(id, next);
    }
    if (r) await r.srem(EVAL_UNDISTILLED, id);
    else memUndistilled.delete(id);
  }
}

// ── Learnings ──────────────────────────────────────────────────────

export async function addLearning(
  l: Omit<Learning, "id" | "createdAt" | "updatedAt"> & { id?: string },
): Promise<Learning> {
  const now = Math.floor(Date.now() / 1000);
  const full: Learning = {
    ...l,
    id: l.id ?? `lrn-${crypto.randomUUID()}`,
    text: l.text.slice(0, MAX_LEARNING_CHARS),
    createdAt: now,
    updatedAt: now,
  };
  const r = client();
  if (r) {
    await r.set(learningKey(full.id), full);
    await r.sadd(LEARNING_IDS, full.id);
  } else {
    memLearnings.set(full.id, full);
  }
  return full;
}

export async function getLearning(id: string): Promise<Learning | null> {
  const r = client();
  if (r) return await r.get<Learning>(learningKey(id));
  return memLearnings.get(id) ?? null;
}

export async function updateLearning(
  id: string,
  patch: Partial<Learning>,
): Promise<Learning | null> {
  const existing = await getLearning(id);
  if (!existing) return null;
  const next: Learning = {
    ...existing,
    ...patch,
    text: (patch.text ?? existing.text).slice(0, MAX_LEARNING_CHARS),
    updatedAt: Math.floor(Date.now() / 1000),
  };
  const r = client();
  if (r) await r.set(learningKey(id), next);
  else memLearnings.set(id, next);
  return next;
}

export async function listLearnings(state?: LearningState): Promise<Learning[]> {
  const r = client();
  let all: Learning[];
  if (r) {
    const ids = await r.smembers(LEARNING_IDS);
    if (!ids.length) return [];
    const raw = await Promise.all(ids.map((id) => r.get<Learning>(learningKey(id))));
    all = [];
    for (let i = 0; i < ids.length; i++) {
      if (raw[i]) all.push(raw[i]!);
      else await r.srem(LEARNING_IDS, ids[i]);
    }
  } else {
    all = [...memLearnings.values()];
  }
  const filtered = state ? all.filter((l) => l.state === state) : all;
  return filtered.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ── Prompt injection ───────────────────────────────────────────────

/** Cap on injected learnings — ≤300 chars each ⇒ worst case ~1.5k tokens. */
const MAX_INJECTED = 20;

/**
 * The "LEARNED GUIDELINES" bullet list for the system prompt: approved
 * learnings matching the product, strongest (most reinforced) first. Stable
 * ordering keeps prompt-cache churn low. Returns "" when there is nothing to
 * inject and NEVER throws — a store blip must not take down reply generation.
 */
export async function getLearningsBlock(product: string): Promise<string> {
  try {
    const approved = await listLearnings("approved");
    const relevant = approved
      .filter((l) => l.product === "all" || l.product === product)
      .sort((a, b) => b.reinforcedCount - a.reinforcedCount || b.updatedAt - a.updatedAt)
      .slice(0, MAX_INJECTED);
    if (!relevant.length) return "";
    return relevant.map((l) => `- ${l.text}`).join("\n");
  } catch {
    return "";
  }
}
