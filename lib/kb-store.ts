/**
 * Unified knowledge-base store — the single home for every KB article.
 *
 * Replaces the old split model (in-code GETSIGN_KB + ManagedArticle blobs +
 * TTL'd PendingDrafts in kv.ts). Everything — seeded GetSign docs, manual
 * articles, Knowledge-Loop drafts — is one KbArticle with a lifecycle state:
 *
 *   draft → in_review → published → archived
 *          (draft → published directly; archived → draft to restore)
 *
 * Governance guarantees:
 *   - Vector-index membership is a function of state: ONLY published articles
 *     are searchable by the agent. Publishing upserts; unpublishing deletes.
 *   - Every content edit bumps `version` and snapshots the new content into a
 *     capped history list (last 20), restorable.
 *   - Every mutation appends an audit event (global feed capped 1000,
 *     per-article capped 100).
 *   - Duplicate detection runs at save time (vector similarity, keyword
 *     fallback) and warns — it never blocks; a human decides.
 *
 * Storage: Upstash Redis under the `jetta:kb2:` namespace (ZSET indexes by
 * state/category, scored by updatedAt), with the same single-process in-memory
 * fallback as kv.ts so local STUB_MODE runs work without credentials.
 */
import crypto from "node:crypto";
import { Redis } from "@upstash/redis";
import { config } from "./config";
import { vectorEnabled, upsertDocs, deleteDocs, queryVector } from "./vector";

// ── Types ──────────────────────────────────────────────────────────

export type ArticleState = "draft" | "in_review" | "published" | "archived";
export type ArticleOrigin = "manual" | "knowledge-loop" | "fd-mined" | "seed-getsign" | "seed-jetpackapps";

export interface KbArticle {
  /** Stable forever; doubles as the vector-index id. */
  id: string;
  title: string;
  /** Public citation URL ("" for internal knowledge-loop articles). */
  url: string;
  body: string;
  keywords: string[];
  /** Category slug from the registry; "" = uncategorized. */
  category: string;
  tags: string[];
  state: ArticleState;
  /** Starts at 1, bumps on every content edit. */
  version: number;
  origin: ArticleOrigin;
  /** Retrieval-source label surfaced to the agent ("getsign.io" | "managed"). */
  source: string;
  createdBy: string;
  createdAt: number;
  updatedBy: string;
  updatedAt: number;
  /** Unix seconds; article counts as stale once this passes. */
  reviewBy?: number;
  /** Draft provenance (Slack knowledge-loop thread, mining channel…). */
  meta?: { channel?: string; threadTs?: string };
  /** Possible duplicates flagged at save time — advisory only. */
  duplicates?: { id: string; title: string; score: number }[];
  /** Freshdesk Solutions sync record (customer-facing help center). */
  freshdesk?: { articleId: string; folderId: string; syncedAt: number; syncedVersion: number };
}

/** Snapshot of the content fields at a given version (newest first, capped). */
export interface ArticleVersion {
  version: number;
  title: string;
  url: string;
  body: string;
  keywords: string[];
  category: string;
  tags: string[];
  editedBy: string;
  at: number;
}

export interface AuditEvent {
  at: number;
  actor: string;
  articleId: string;
  title: string;
  action:
    | "create"
    | "update"
    | "state_change"
    | "delete"
    | "restore"
    | "fd_push"
    | "fd_push_error";
  fromState?: ArticleState;
  toState?: ArticleState;
  version?: number;
  detail?: string;
}

export interface KbCategory {
  slug: string;
  name: string;
  /** Freshdesk Solutions folder this category publishes into. */
  fdFolderId?: string;
}

export interface NewArticle {
  id?: string;
  title: string;
  url?: string;
  body: string;
  keywords?: string[];
  category?: string;
  tags?: string[];
  state?: ArticleState;
  origin: ArticleOrigin;
  source?: string;
  createdBy: string;
  reviewBy?: number;
  meta?: KbArticle["meta"];
}

// ── State machine ──────────────────────────────────────────────────

const TRANSITIONS: Record<ArticleState, ArticleState[]> = {
  draft: ["in_review", "published"],
  in_review: ["draft", "published"],
  published: ["archived"],
  archived: ["draft"],
};

export function canTransition(from: ArticleState, to: ArticleState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export const ARTICLE_STATES: ArticleState[] = ["draft", "in_review", "published", "archived"];

// ── Keys + client ──────────────────────────────────────────────────

const artKey = (id: string) => `jetta:kb2:art:${id}`;
const IDS_ZSET = "jetta:kb2:ids";
const stateKey = (s: ArticleState) => `jetta:kb2:state:${s}`;
const catKey = (slug: string) => `jetta:kb2:cat:${slug}`;
const CATS_HASH = "jetta:kb2:cats";
const versKey = (id: string) => `jetta:kb2:vers:${id}`;
const AUDIT_LIST = "jetta:kb2:audit";
const auditKey = (id: string) => `jetta:kb2:audit:${id}`;
const REVIEW_ZSET = "jetta:kb2:review";

const VERSION_CAP = 20;
const AUDIT_CAP = 1000;
const ARTICLE_AUDIT_CAP = 100;
/** Vector-similarity score above which two articles are flagged as duplicates. */
const DUP_SCORE_BAR = 0.86;

let redis: Redis | null = null;
function client(): Redis | null {
  if (config.kv.url && config.kv.token) {
    redis ??= new Redis({ url: config.kv.url, token: config.kv.token });
    return redis;
  }
  return null;
}

// In-memory fallback (single-process only, mirrors kv.ts).
const memArts = new Map<string, KbArticle>();
const memVers = new Map<string, ArticleVersion[]>();
const memAudit: AuditEvent[] = [];
const memCats = new Map<string, KbCategory>();

const now = () => Math.floor(Date.now() / 1000);

/**
 * When Redis is unconfigured (credential-less STUB runs), lazily seed the
 * in-memory store from the in-code GetSign corpus so the agent still has a
 * grounded KB. Ids match scripts/kb-ingest.ts derivation, same as kb-migrate.
 */
let memSeeded = false;
function memSeedIfNeeded(): void {
  if (client() || memSeeded) return;
  memSeeded = true;
  // Lazy require avoids the corpus in the hot path when Redis is configured.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { GETSIGN_KB } = require("./knowledge/getsign-kb") as {
    GETSIGN_KB: { title: string; url: string; body: string; keywords?: string[]; source: string }[];
  };
  const slug = (s: string) =>
    s.toLowerCase().replace(/https?:\/\//, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 120);
  const t = now();
  GETSIGN_KB.forEach((a, i) => {
    const id = a.url ? slug(a.url) + "-" + i : `kb-${i}`;
    memArts.set(id, {
      id,
      title: a.title,
      url: a.url,
      body: a.body,
      keywords: a.keywords ?? [],
      category: "",
      tags: [],
      state: "published",
      version: 1,
      origin: "seed-getsign",
      source: a.source,
      createdBy: "mem-seed",
      createdAt: t,
      updatedBy: "mem-seed",
      updatedAt: t,
    });
  });
}

// ── Internal helpers ───────────────────────────────────────────────

function snapshotOf(a: KbArticle, editedBy: string): ArticleVersion {
  return {
    version: a.version,
    title: a.title,
    url: a.url,
    body: a.body,
    keywords: a.keywords,
    category: a.category,
    tags: a.tags,
    editedBy,
    at: now(),
  };
}

function contentChanged(a: KbArticle, b: KbArticle): boolean {
  return (
    a.title !== b.title ||
    a.url !== b.url ||
    a.body !== b.body ||
    a.category !== b.category ||
    JSON.stringify(a.keywords) !== JSON.stringify(b.keywords) ||
    JSON.stringify(a.tags) !== JSON.stringify(b.tags)
  );
}

/**
 * Persist an article + all its indexes in one pipeline. `prev` (if any) tells
 * us which state/category ZSETs to leave. Optionally snapshots a version and
 * appends an audit event in the same round trip.
 */
async function persist(
  a: KbArticle,
  prev: KbArticle | null,
  opts: { snapshot?: ArticleVersion; audit: AuditEvent },
): Promise<void> {
  const r = client();
  if (r) {
    const p = r.pipeline();
    p.set(artKey(a.id), a);
    p.zadd(IDS_ZSET, { score: a.updatedAt, member: a.id });
    if (prev && prev.state !== a.state) p.zrem(stateKey(prev.state), a.id);
    p.zadd(stateKey(a.state), { score: a.updatedAt, member: a.id });
    if (prev && prev.category && prev.category !== a.category) p.zrem(catKey(prev.category), a.id);
    if (a.category) p.zadd(catKey(a.category), { score: a.updatedAt, member: a.id });
    if (a.reviewBy) p.zadd(REVIEW_ZSET, { score: a.reviewBy, member: a.id });
    else if (prev?.reviewBy) p.zrem(REVIEW_ZSET, a.id);
    if (opts.snapshot) {
      p.lpush(versKey(a.id), opts.snapshot);
      p.ltrim(versKey(a.id), 0, VERSION_CAP - 1);
    }
    p.lpush(AUDIT_LIST, opts.audit);
    p.ltrim(AUDIT_LIST, 0, AUDIT_CAP - 1);
    p.lpush(auditKey(a.id), opts.audit);
    p.ltrim(auditKey(a.id), 0, ARTICLE_AUDIT_CAP - 1);
    await p.exec();
    return;
  }
  memArts.set(a.id, a);
  if (opts.snapshot) {
    const list = memVers.get(a.id) ?? [];
    list.unshift(opts.snapshot);
    memVers.set(a.id, list.slice(0, VERSION_CAP));
  }
  memAudit.unshift(opts.audit);
  if (memAudit.length > AUDIT_CAP) memAudit.length = AUDIT_CAP;
}

/** Keep the vector index consistent with lifecycle state. Never throws. */
async function syncVector(a: KbArticle, wasPublished: boolean): Promise<void> {
  if (!vectorEnabled()) return;
  try {
    if (a.state === "published") {
      await upsertDocs([{ id: a.id, title: a.title, url: a.url, body: a.body, source: a.source }]);
    } else if (wasPublished) {
      await deleteDocs([a.id]);
    }
  } catch (e) {
    console.warn(`kb-store: vector sync failed for ${a.id}:`, e instanceof Error ? e.message : e);
  }
}

// ── CRUD + lifecycle ───────────────────────────────────────────────

export async function getArticle(id: string): Promise<KbArticle | null> {
  const r = client();
  if (r) return await r.get<KbArticle>(artKey(id));
  memSeedIfNeeded();
  return memArts.get(id) ?? null;
}

export interface CreateOptions {
  /** Skip vector upsert (bulk migration re-uses existing embeddings). */
  syncVector?: boolean;
  /** Skip duplicate detection (bulk migration/seeding). */
  checkDuplicates?: boolean;
}

export async function createArticle(
  input: NewArticle,
  opts: CreateOptions = {},
): Promise<KbArticle> {
  const t = now();
  const article: KbArticle = {
    id: input.id ?? `kb-${crypto.randomUUID()}`,
    title: input.title,
    url: input.url ?? "",
    body: input.body,
    keywords: input.keywords ?? [],
    category: input.category ?? "",
    tags: input.tags ?? [],
    state: input.state ?? "draft",
    version: 1,
    origin: input.origin,
    source: input.source ?? "managed",
    createdBy: input.createdBy,
    createdAt: t,
    updatedBy: input.createdBy,
    updatedAt: t,
    reviewBy: input.reviewBy ?? (input.state === "draft" || !input.state ? t + 14 * 86400 : undefined),
    meta: input.meta,
  };
  if (opts.checkDuplicates !== false) {
    article.duplicates = await findDuplicates(article.title, article.body, article.id).catch(() => []);
  }
  await persist(article, null, {
    snapshot: snapshotOf(article, input.createdBy),
    audit: {
      at: t,
      actor: input.createdBy,
      articleId: article.id,
      title: article.title,
      action: "create",
      toState: article.state,
      version: 1,
    },
  });
  if (opts.syncVector !== false) await syncVector(article, false);
  return article;
}

export type ArticlePatch = Partial<
  Pick<KbArticle, "title" | "url" | "body" | "keywords" | "category" | "tags" | "reviewBy">
>;

/** Edit content/metadata. Content changes bump the version + snapshot. */
export async function updateArticle(
  id: string,
  patch: ArticlePatch,
  actor: string,
): Promise<KbArticle | null> {
  const prev = await getArticle(id);
  if (!prev) return null;
  const next: KbArticle = {
    ...prev,
    ...("title" in patch ? { title: patch.title ?? prev.title } : {}),
    ...("url" in patch ? { url: patch.url ?? prev.url } : {}),
    ...("body" in patch ? { body: patch.body ?? prev.body } : {}),
    ...("keywords" in patch ? { keywords: patch.keywords ?? prev.keywords } : {}),
    ...("category" in patch ? { category: patch.category ?? prev.category } : {}),
    ...("tags" in patch ? { tags: patch.tags ?? prev.tags } : {}),
    ...("reviewBy" in patch ? { reviewBy: patch.reviewBy } : {}),
    updatedBy: actor,
    updatedAt: now(),
  };
  const changed = contentChanged(prev, next);
  if (changed) {
    next.version = prev.version + 1;
    next.duplicates = await findDuplicates(next.title, next.body, next.id).catch(() => prev.duplicates ?? []);
  }
  await persist(next, prev, {
    snapshot: changed ? snapshotOf(next, actor) : undefined,
    audit: {
      at: next.updatedAt,
      actor,
      articleId: id,
      title: next.title,
      action: "update",
      version: next.version,
      detail: changed ? "content edit" : "metadata edit",
    },
  });
  if (changed && next.state === "published") await syncVector(next, true);
  return next;
}

/** Move an article through the lifecycle. Throws on an illegal transition. */
export async function transitionState(
  id: string,
  to: ArticleState,
  actor: string,
): Promise<KbArticle> {
  const prev = await getArticle(id);
  if (!prev) throw new Error(`article ${id} not found`);
  if (prev.state === to) return prev;
  if (!canTransition(prev.state, to)) {
    throw new Error(`illegal transition ${prev.state} → ${to}`);
  }
  const next: KbArticle = { ...prev, state: to, updatedBy: actor, updatedAt: now() };
  await persist(next, prev, {
    audit: {
      at: next.updatedAt,
      actor,
      articleId: id,
      title: next.title,
      action: "state_change",
      fromState: prev.state,
      toState: to,
    },
  });
  await syncVector(next, prev.state === "published");
  return next;
}

export async function deleteArticle(id: string, actor: string): Promise<boolean> {
  const prev = await getArticle(id);
  if (!prev) return false;
  const r = client();
  const audit: AuditEvent = {
    at: now(),
    actor,
    articleId: id,
    title: prev.title,
    action: "delete",
    fromState: prev.state,
  };
  if (r) {
    const p = r.pipeline();
    p.del(artKey(id));
    p.del(versKey(id));
    p.zrem(IDS_ZSET, id);
    p.zrem(stateKey(prev.state), id);
    if (prev.category) p.zrem(catKey(prev.category), id);
    p.zrem(REVIEW_ZSET, id);
    p.lpush(AUDIT_LIST, audit);
    p.ltrim(AUDIT_LIST, 0, AUDIT_CAP - 1);
    await p.exec();
  } else {
    memArts.delete(id);
    memVers.delete(id);
    memAudit.unshift(audit);
  }
  if (prev.state === "published" && vectorEnabled()) {
    await deleteDocs([id]).catch(() => {});
  }
  return true;
}

// ── Listing / filtering ────────────────────────────────────────────

export interface ListOptions {
  state?: ArticleState;
  category?: string;
  limit?: number;
  offset?: number;
}

/** Newest-first listing from the narrowest ZSET index. */
export async function listArticles(opts: ListOptions = {}): Promise<KbArticle[]> {
  const { state, category, limit = 200, offset = 0 } = opts;
  const r = client();
  if (!r) {
    memSeedIfNeeded();
    return [...memArts.values()]
      .filter((a) => (!state || a.state === state) && (!category || a.category === category))
      .sort((x, y) => y.updatedAt - x.updatedAt)
      .slice(offset, offset + limit);
  }
  // Narrowest index wins; when both filters are set, read the state ZSET and
  // filter category in memory (corpus is small).
  const key = state ? stateKey(state) : category ? catKey(category) : IDS_ZSET;
  const both = !!(state && category);
  const start = both ? 0 : offset;
  const stop = both ? 499 : offset + limit - 1;
  const ids = await r.zrange<string[]>(key, start, stop, { rev: true });
  if (!ids.length) return [];
  const raw = await r.mget<(KbArticle | null)[]>(...ids.map(artKey));
  let out = raw.filter((a): a is KbArticle => !!a);
  if (both) out = out.filter((a) => a.category === category).slice(offset, offset + limit);
  return out;
}

export async function countByState(): Promise<Record<ArticleState, number>> {
  const r = client();
  const out = { draft: 0, in_review: 0, published: 0, archived: 0 } as Record<ArticleState, number>;
  if (r) {
    const counts = await Promise.all(ARTICLE_STATES.map((s) => r.zcard(stateKey(s))));
    ARTICLE_STATES.forEach((s, i) => (out[s] = counts[i] ?? 0));
    return out;
  }
  for (const a of memArts.values()) out[a.state]++;
  return out;
}

/** Articles whose reviewBy date has passed (stale, need a human look). */
export async function listStaleArticles(asOf = now()): Promise<KbArticle[]> {
  const r = client();
  if (!r) {
    return [...memArts.values()]
      .filter((a) => a.reviewBy && a.reviewBy <= asOf)
      .sort((x, y) => (x.reviewBy ?? 0) - (y.reviewBy ?? 0));
  }
  const ids = await r.zrange<string[]>(REVIEW_ZSET, 0, asOf, { byScore: true });
  if (!ids.length) return [];
  const raw = await r.mget<(KbArticle | null)[]>(...ids.map(artKey));
  return raw.filter((a): a is KbArticle => !!a);
}

// ── Versions & audit ───────────────────────────────────────────────

export async function listVersions(id: string): Promise<ArticleVersion[]> {
  const r = client();
  if (r) {
    const raw = await r.lrange<ArticleVersion | string>(versKey(id), 0, VERSION_CAP - 1);
    return raw.map((x) => (typeof x === "string" ? (JSON.parse(x) as ArticleVersion) : x));
  }
  return memVers.get(id) ?? [];
}

/** Restore an old version's content as a NEW version (never rewrites history). */
export async function restoreVersion(
  id: string,
  version: number,
  actor: string,
): Promise<KbArticle | null> {
  const versions = await listVersions(id);
  const snap = versions.find((v) => v.version === version);
  if (!snap) return null;
  const prev = await getArticle(id);
  if (!prev) return null;
  const next: KbArticle = {
    ...prev,
    title: snap.title,
    url: snap.url,
    body: snap.body,
    keywords: snap.keywords,
    category: snap.category,
    tags: snap.tags,
    version: prev.version + 1,
    updatedBy: actor,
    updatedAt: now(),
  };
  await persist(next, prev, {
    snapshot: snapshotOf(next, actor),
    audit: {
      at: next.updatedAt,
      actor,
      articleId: id,
      title: next.title,
      action: "restore",
      version: next.version,
      detail: `restored content of v${version}`,
    },
  });
  if (next.state === "published") await syncVector(next, true);
  return next;
}

export async function getAuditFeed(limit = 100): Promise<AuditEvent[]> {
  const r = client();
  if (r) {
    const raw = await r.lrange<AuditEvent | string>(AUDIT_LIST, 0, limit - 1);
    return raw.map((x) => (typeof x === "string" ? (JSON.parse(x) as AuditEvent) : x));
  }
  return memAudit.slice(0, limit);
}

export async function getArticleAudit(id: string, limit = 50): Promise<AuditEvent[]> {
  const r = client();
  if (r) {
    const raw = await r.lrange<AuditEvent | string>(auditKey(id), 0, limit - 1);
    return raw.map((x) => (typeof x === "string" ? (JSON.parse(x) as AuditEvent) : x));
  }
  return memAudit.filter((e) => e.articleId === id).slice(0, limit);
}

/** Append a bare audit event (Freshdesk pushes and other side effects). */
export async function recordAudit(e: AuditEvent): Promise<void> {
  const r = client();
  if (r) {
    const p = r.pipeline();
    p.lpush(AUDIT_LIST, e);
    p.ltrim(AUDIT_LIST, 0, AUDIT_CAP - 1);
    p.lpush(auditKey(e.articleId), e);
    p.ltrim(auditKey(e.articleId), 0, ARTICLE_AUDIT_CAP - 1);
    await p.exec();
    return;
  }
  memAudit.unshift(e);
  if (memAudit.length > AUDIT_CAP) memAudit.length = AUDIT_CAP;
}

// ── Categories ─────────────────────────────────────────────────────

export async function listCategories(): Promise<KbCategory[]> {
  const r = client();
  if (r) {
    const all = await r.hgetall<Record<string, KbCategory>>(CATS_HASH);
    return Object.values(all ?? {}).sort((a, b) => a.name.localeCompare(b.name));
  }
  return [...memCats.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function upsertCategory(cat: KbCategory): Promise<void> {
  const r = client();
  if (r) {
    await r.hset(CATS_HASH, { [cat.slug]: cat });
    return;
  }
  memCats.set(cat.slug, cat);
}

// ── Search + duplicate detection ───────────────────────────────────

export interface KbHit {
  id: string;
  title: string;
  url: string;
  body: string;
  source: string;
  score?: number;
}

function scoreArticle(a: KbArticle, terms: string[]): number {
  const title = a.title.toLowerCase();
  const kw = a.keywords.join(" ").toLowerCase();
  const body = a.body.toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (title.includes(t)) score += 3;
    if (kw.includes(t)) score += 2;
    if (body.includes(t)) score += 1;
  }
  return score;
}

/**
 * Keyword search over PUBLISHED articles — the agent's fallback when the
 * vector store is unavailable (replaces searchManagedKb + searchGetSignKb).
 */
export async function searchPublishedKb(query: string, limit = 5): Promise<KbHit[]> {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
  if (!terms.length) return [];
  const articles = await listArticles({ state: "published", limit: 500 }).catch(() => []);
  return articles
    .map((a) => ({ a, score: scoreArticle(a, terms) }))
    .filter((s) => s.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
    .map(({ a, score }) => ({ id: a.id, title: a.title, url: a.url, body: a.body, source: a.source, score }));
}

/**
 * Flag likely duplicates of the given content. Vector similarity when
 * available (score ≥ 0.86), else keyword-overlap heuristic. Advisory only.
 */
export async function findDuplicates(
  title: string,
  body: string,
  excludeId?: string,
): Promise<{ id: string; title: string; score: number }[]> {
  if (vectorEnabled()) {
    const hits = await queryVector(`${title}\n\n${body.slice(0, 1000)}`, 4).catch(() => []);
    return hits
      .filter((h) => h.id !== excludeId && h.score >= DUP_SCORE_BAR)
      .map((h) => ({ id: h.id, title: h.title, score: +h.score.toFixed(3) }));
  }
  const hits = await searchPublishedKb(title, 4);
  // Keyword scores aren't normalized; require a strong title-term overlap.
  return hits
    .filter((h) => h.id !== excludeId && (h.score ?? 0) >= 9)
    .map((h) => ({ id: h.id, title: h.title, score: h.score ?? 0 }));
}

// ── Freshdesk sync bookkeeping ─────────────────────────────────────

export async function setFreshdeskSync(
  id: string,
  sync: NonNullable<KbArticle["freshdesk"]>,
  actor: string,
): Promise<KbArticle | null> {
  const prev = await getArticle(id);
  if (!prev) return null;
  const next: KbArticle = { ...prev, freshdesk: sync, updatedBy: actor, updatedAt: now() };
  await persist(next, prev, {
    audit: {
      at: next.updatedAt,
      actor,
      articleId: id,
      title: next.title,
      action: "fd_push",
      version: sync.syncedVersion,
      detail: `pushed to Freshdesk article ${sync.articleId}`,
    },
  });
  return next;
}
