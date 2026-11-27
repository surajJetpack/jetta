/**
 * The GetSign configuration reference, as knowledge base drafts.
 *
 * The GetSign app team keeps a reference of every screen, setting and flow in
 * their own repository (getsign-board-view, docs/agent/getsign-configuration-
 * reference.md). It answers what the website articles do not: where a setting
 * lives, what a field does, why a workflow will not save.
 *
 * Three files:
 *   - knowledge/getsign-reference-doc.ts: the doc itself, vendored by
 *     scripts/pull-getsign-reference.mjs. A refresh is a diff someone reads,
 *     and no GitHub token is needed at runtime.
 *   - knowledge/getsign-reference-articles.ts: the same content rewritten for
 *     customers. The doc is full of file paths, component names and form field
 *     names that must never reach one, and cutting them out mechanically left
 *     tables with no subject, so the articles are written by hand and pinned
 *     to the doc by a fingerprint per section (`sourceSections`).
 *   - this file: the fingerprints, the check for anything code-like, and the
 *     sync that files the articles in the review queue.
 *
 * Every article arrives as a DRAFT and nothing is searchable until a person
 * publishes it, for ordinary review. The doc is read from the app's `main`
 * branch, which is what customers have: the developers update it on `dev` in
 * the same change as the screen, so `dev` can describe a screen that is not
 * released yet (read from `dev` until 2026-11-27).
 *
 * The doc changes after the articles are written. Each daily run reads it
 * again (`fetchReference`, when a token is set) and `articlesFor` redrafts,
 * with the model, any article whose section's fingerprint moved. The redraft
 * goes through the same check for code names as the hand-written text.
 *
 * After that the articles follow the same rules as the site sync
 * (lib/kb-sync.ts): a draft nobody has touched is updated in place; anything a
 * person has edited or published is never overwritten, and a change files a
 * notice in the review queue instead; a rejected draft stays rejected until
 * its article changes.
 */
import crypto from "node:crypto";
import {
  getArticle,
  createArticle,
  updateArticle,
  deleteArticle,
  transitionState,
  listArticles,
  getSiteRecord,
  setSiteRecord,
  type KbArticle,
} from "./kb-store";
import { generateObject } from "ai";
import { z } from "zod";
import { config } from "./config";
import { getModel, llmKeyPresent } from "./llm";
import { describeChange, machineOnly, pageHash, slug, type PageChange } from "./kb-sync";
import { GETSIGN_REFERENCE } from "./knowledge/getsign-reference-doc";
import { GETSIGN_REFERENCE_ARTICLES, type ReferenceArticle } from "./knowledge/getsign-reference-articles";
import { log } from "./logger";

export const REFERENCE_ACTOR = "kb-getsign-reference";
export const REFERENCE_SOURCE = "getsign-reference";

// ── Pinning the articles to the doc ────────────────────────────────

/**
 * The doc's top-level sections, each with a fingerprint of its text. The
 * number in front of a heading is dropped, so renumbering changes nothing.
 */
export function sourceSections(markdown: string): { section: string; hash: string; text: string }[] {
  return markdown
    .split(/^## /m)
    .slice(1)
    .map((part) => {
      const nl = part.indexOf("\n");
      const section = part
        .slice(0, nl)
        .replace(/^\d+\s*[.—-]?\s*/, "")
        .replace(/\s*\(`[^`]*`\)/g, "")
        .trim();
      const text = part.slice(nl + 1).replace(/\s+/g, " ").trim();
      return {
        section,
        hash: crypto.createHash("sha256").update(text).digest("hex").slice(0, 12),
        text: part.slice(nl + 1).trim(),
      };
    });
}

/** Articles whose source section changed, or is gone, since they were written. */
export function staleArticles(
  markdown: string = GETSIGN_REFERENCE.markdown,
  articles: ReferenceArticle[] = GETSIGN_REFERENCE_ARTICLES,
): { id: string; section: string; expected: string; actual: string | null }[] {
  const now = new Map(sourceSections(markdown).map((s) => [s.section, s.hash]));
  const stale = [];
  for (const a of articles) {
    for (const f of a.from) {
      const actual = now.get(f.section) ?? null;
      if (actual !== f.hash) stale.push({ id: a.id, section: f.section, expected: f.hash, actual });
    }
  }
  return stale;
}

/**
 * Anything in an article that looks like code rather than a screen: a code
 * span, a source path, a camelCase name, a file name, a URL path inside the
 * app. Empty means clean.
 */
export function leftovers(body: string): string[] {
  const found = new Set<string>();
  const pattern =
    /`[^`]*`|\bsrc\/[\w/.-]+|\b[a-z]+[A-Z][A-Za-z]+\b|\b[\w-]+\.(?:tsx?|md|json)\b|(?<![\w.<])\/[a-z][\w-]*(?:\/[:\w-]+)*/g;
  for (const m of body.matchAll(pattern)) found.add(m[0]);
  return [...found];
}

// ── The reference as it is today ───────────────────────────────────

const REPO = "Jetpack-Work-Labs/getsign-board-view";
const DOC_PATH = "docs/agent/getsign-configuration-reference.md";
/** Sections that are for the doc's maintainers, never for an article. */
const INTERNAL_SECTION = /file index|maintainers/i;
/** Fewer sections than this is a broken read, not a rewrite of the doc. */
const MIN_SECTIONS = 5;

/**
 * The reference as it stands on the app's main branch (what is released), or
 * null when there is no token, no network (stub mode) or the read looks wrong.
 * Null means "use the copy shipped with the code", never "the reference is
 * empty".
 */
export async function fetchReference(): Promise<string | null> {
  // The token alone decides (lib/github.ts githubReady explains why not stub mode).
  if (!config.getsignReferenceToken) return null;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${DOC_PATH}?ref=main`, {
      headers: {
        Authorization: `Bearer ${config.getsignReferenceToken}`,
        Accept: "application/vnd.github.raw",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "jetta-kb-sync",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const markdown = await res.text();
    if (sourceSections(markdown).length < MIN_SECTIONS) throw new Error("the reference came back with too few sections");
    return markdown;
  } catch (e) {
    log.warn("kbsync.reference_fetch_failed", { error: e instanceof Error ? e.message : String(e), source: "cron" });
    return null;
  }
}

const RewriteSchema = z.object({
  title: z.string().describe("Article title, starting with 'GetSign'."),
  body: z.string().describe("The article in markdown, for customers."),
  keywords: z.array(z.string()).describe("6-15 lowercase search terms a customer might type."),
});
export type Rewrite = z.infer<typeof RewriteSchema>;
export interface RewriteInput {
  /** The article as it stands, or null when the section is new. */
  current: { title: string; body: string } | null;
  /** The reference sections it is written from, as they are now. */
  sections: { section: string; text: string }[];
}
export type Rewriter = (input: RewriteInput, problem?: string) => Promise<Rewrite>;

const REWRITE_SYSTEM = `You maintain knowledge-base articles about GetSign, an e-signature app inside monday.com, for a customer support agent.

You are given sections of the developers' configuration reference and, usually, the current article written from an earlier version of them. Bring the article in line with the sections as they are now.

Rules:
- Use ONLY what the sections say. Do not invent steps, labels, limits or behaviour.
- Write for a customer: what they see on screen (screen names, tabs, labels, buttons, steps) and the rules behind it (what is required, what is locked on which plan, why something will not save).
- Leave out everything about the code: file names and paths, component, hook and function names, form field code names (camelCase or dotted), route or URL paths inside the app, API endpoints, status codes, libraries. Where the reference gives only a code name for a field, describe the field by what it does.
- No code formatting (no backticks) anywhere.
- When there is a current article, keep its structure and wording wherever the reference has not changed; change only what the reference changed, added or removed.
- Plain, direct sentences. Markdown headings (##), lists and tables as the current article uses them.`;

const modelRewriter: Rewriter = async (input, problem) => {
  const { object } = await generateObject({
    model: getModel(),
    schema: RewriteSchema,
    system: REWRITE_SYSTEM,
    prompt:
      input.sections.map((s) => `REFERENCE SECTION: ${s.section}\n\n${s.text}`).join("\n\n---\n\n") +
      (input.current
        ? `\n\n---\n\nCURRENT ARTICLE: ${input.current.title}\n\n${input.current.body}`
        : "\n\n---\n\nThere is no article for this section yet. Write one.") +
      (problem ? `\n\nYour last attempt was refused: ${problem}` : ""),
  });
  return object;
};

/** A rewrite that names nothing internal, or null after two refused attempts. */
async function safeRewrite(input: RewriteInput, rewrite: Rewriter): Promise<Rewrite | null> {
  let problem: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await rewrite(input, problem);
    const bad = leftovers(`${out.title}\n${out.body}`);
    if (!bad.length && out.body.trim().length >= 200) return { ...out, body: out.body.trim() };
    problem = bad.length
      ? `it still contained code names or paths (${bad.slice(0, 12).join(", ")}). Describe those by what the customer sees instead.`
      : "the body was too short to be an article.";
  }
  return null;
}

export interface LiveArticles {
  articles: ReferenceArticle[];
  /** Articles redrafted in this run because their section changed. */
  rewritten: string[];
  /** Articles whose section changed but could not be redrafted; retried next run. */
  pending: string[];
}

const liveKey = (id: string) => `${id}--live`;

/**
 * The articles as they should read given the reference as it is today.
 *
 * An article whose sections are unchanged is the hand-written one. One whose
 * section changed is redrafted by the model from the new section, and the
 * redraft is kept against the section's fingerprint: a model words things
 * differently every time, and without that every daily run would look like
 * another change. A section no article covers gets a new article the same
 * way. An article all of whose sections are gone is left out, which the sync
 * then treats as retired.
 */
export async function articlesFor(
  markdown: string,
  opts: { articles?: ReferenceArticle[]; rewrite?: Rewriter; dryRun?: boolean } = {},
): Promise<LiveArticles> {
  const curated = opts.articles ?? GETSIGN_REFERENCE_ARTICLES;
  const rewrite = opts.rewrite ?? (llmKeyPresent() ? modelRewriter : null);
  const live = new Map(sourceSections(markdown).map((s) => [s.section, s]));
  const out: LiveArticles = { articles: [], rewritten: [], pending: [] };

  const redraft = async (base: ReferenceArticle, sections: { section: string; hash: string; text: string }[], isNew: boolean) => {
    const key = sections.map((s) => `${s.section}:${s.hash}`).join("|");
    const cached = await getSiteRecord(liveKey(base.id));
    const kept = (): ReferenceArticle | null => {
      if (!cached) return isNew ? null : base;
      const c = JSON.parse(cached.text) as Rewrite;
      return { ...base, title: c.title, body: c.body, keywords: c.keywords };
    };
    if (cached?.hash === key) return kept();
    if (!rewrite || opts.dryRun) {
      out.pending.push(base.id);
      return kept();
    }
    try {
      const prev = kept();
      const fresh = await safeRewrite(
        { current: prev?.body ? { title: prev.title, body: prev.body } : null, sections },
        rewrite,
      );
      if (!fresh) throw new Error("the redraft still named code after two attempts");
      await setSiteRecord(liveKey(base.id), { text: JSON.stringify(fresh), hash: key });
      out.rewritten.push(base.id);
      return { ...base, title: fresh.title, body: fresh.body, keywords: fresh.keywords };
    } catch (e) {
      log.warn("kbsync.reference_rewrite_failed", { id: base.id, error: e instanceof Error ? e.message : String(e), source: "cron" });
      out.pending.push(base.id);
      return kept();
    }
  };

  const covered = new Set<string>();
  for (const a of curated) {
    for (const f of a.from) covered.add(f.section);
    const present = a.from.flatMap((f) => (live.has(f.section) ? [live.get(f.section)!] : []));
    if (!present.length) continue; // every section it was written from is gone
    const same = present.length === a.from.length && a.from.every((f) => live.get(f.section)!.hash === f.hash);
    const article = same ? a : await redraft(a, present, false);
    if (article) out.articles.push(article);
  }
  for (const s of live.values()) {
    if (covered.has(s.section) || INTERNAL_SECTION.test(s.section)) continue;
    const base: ReferenceArticle = {
      id: `getsign-ref-${slug(s.section)}`,
      title: `GetSign: ${s.section}`,
      keywords: ["getsign"],
      from: [{ section: s.section, hash: s.hash }],
      body: "",
    };
    const article = await redraft(base, [s], true);
    if (article) out.articles.push(article);
  }
  return out;
}

// ── Into the knowledge base ────────────────────────────────────────

export interface ReferenceSyncResult {
  /** "live" when the reference was read from GitHub in this run. */
  reference: "live" | "shipped" | "given";
  articles: number;
  created: number;
  updated: number;
  noticed: string[];
  unchanged: number;
  /** Drafts a person rejected; they stay out until the article changes. */
  rejected: number;
  /** Articles in the store whose entry is gone from the articles file. */
  retired: { id: string; action: RetiredAction }[];
  /** Redrafted in this run because the reference changed under them. */
  rewritten: string[];
  /** Changed in the reference but not redrafted yet (no model, or it failed). */
  pending: string[];
}

export type RetiredAction = "leave" | "notice" | "remove";

/**
 * What happens to an article in the store once its entry has been deleted from
 * knowledge/getsign-reference-articles.ts (the app team dropped the screen it
 * described, or two articles were merged).
 *
 *   "leave"  — nothing; a person archives it when they notice.
 *   "notice" — a to-do in the review queue naming the article.
 *   "remove" — a draft nobody touched is deleted; a published article is
 *              archived, which takes it out of Jetta's search at once.
 */
export function onRetired(article: KbArticle, untouched: boolean): RetiredAction {
  // A draft only the machine wrote goes the way it came. Anything a person
  // has edited or approved is theirs: say so in the queue and let them decide,
  // because a section can also vanish by mistake.
  return untouched && article.state === "draft" ? "remove" : "notice";
}

const noticeIdFor = (id: string) => `${id}--site-change`;

function noticeBody(title: string, id: string, change: PageChange): string {
  const quote = (ps: string[]) =>
    ps.slice(0, 8).map((x) => `> ${x.replace(/\n+/g, " ")}`).join("\n\n") +
    (ps.length > 8 ? `\n\n…and ${ps.length - 8} more` : "");
  return [
    `**The GetSign team changed the reference section behind [${title}](/kb/article?id=${encodeURIComponent(id)}).**`,
    "",
    "Jetta still answers from the article as written: a section a person has edited or published is never overwritten. " +
      "If anything below changes the answer, edit the article; then mark this handled.",
    "",
    `About ${change.words} words changed. The passages below are from the article as it would now read. ` +
      "The reference is read from the app's released branch, so the change is live for customers.",
    ...(change.added.length ? ["", "### Now in the redraft", "", quote(change.added)] : []),
    ...(change.removed.length ? ["", "### No longer in the redraft", "", quote(change.removed)] : []),
  ].join("\n");
}

export async function syncGetSignReference(
  opts: { dryRun?: boolean; articles?: ReferenceArticle[]; markdown?: string; rewrite?: Rewriter } = {},
): Promise<ReferenceSyncResult> {
  const dry = opts.dryRun === true;
  const fetched = opts.articles || opts.markdown ? null : await fetchReference();
  const markdown = opts.markdown ?? fetched ?? GETSIGN_REFERENCE.markdown;
  const live = opts.articles
    ? { articles: opts.articles, rewritten: [], pending: [] }
    : await articlesFor(markdown, { rewrite: opts.rewrite, dryRun: dry });
  const sections = live.articles;
  const res: ReferenceSyncResult = {
    reference: fetched ? "live" : opts.articles || opts.markdown ? "given" : "shipped",
    articles: sections.length,
    created: 0,
    updated: 0,
    noticed: [],
    unchanged: 0,
    rejected: 0,
    retired: [],
    rewritten: live.rewritten,
    pending: live.pending,
  };

  for (const s of sections) {
    const hash = pageHash(s.title, s.body);
    const existing = await getArticle(s.id);
    let rec = await getSiteRecord(s.id);
    const noticeId = noticeIdFor(s.id);
    const noticeOpen = Boolean(await getArticle(noticeId));

    if (!existing) {
      // Rejected in the review queue, and the section has not changed since.
      if (rec?.hash === hash) {
        res.rejected++;
        continue;
      }
      res.created++;
      if (dry) continue;
      await createArticle(
        {
          id: s.id,
          title: s.title,
          body: s.body,
          keywords: s.keywords,
          tags: ["getsign", "reference"],
          state: "draft",
          origin: "getsign-reference",
          source: REFERENCE_SOURCE,
          product: "getsign",
          createdBy: REFERENCE_ACTOR,
        },
        { syncVector: false },
      );
      await setSiteRecord(s.id, { text: s.body, hash });
      continue;
    }

    if (rec?.pending && !noticeOpen) {
      // The last notice was handled: what it asked about is now the baseline.
      rec = { text: rec.pending.text, hash: rec.pending.hash };
      if (!dry) await setSiteRecord(s.id, rec);
    }
    if (rec?.hash === hash || rec?.pending?.hash === hash) {
      res.unchanged++;
      continue;
    }

    // Still the machine's own draft: it follows the reference.
    if (existing.state === "draft" && (await machineOnly(existing))) {
      if (existing.body === s.body && existing.title === s.title) {
        res.unchanged++;
        if (!dry) await setSiteRecord(s.id, { text: s.body, hash });
        continue;
      }
      res.updated++;
      if (dry) continue;
      await updateArticle(s.id, { title: s.title, body: s.body, keywords: s.keywords }, REFERENCE_ACTOR);
      await setSiteRecord(s.id, { text: s.body, hash });
      continue;
    }

    // A person owns it now. Say what changed; never write to the article.
    if (!rec) {
      // No baseline to compare against (the record was lost): start one.
      res.unchanged++;
      if (!dry) await setSiteRecord(s.id, { text: s.body, hash });
      continue;
    }
    const change = describeChange(rec.text, s.body);
    if (!change.added.length && !change.removed.length) {
      res.unchanged++;
      if (!dry) await setSiteRecord(s.id, { text: s.body, hash });
      continue;
    }
    res.noticed.push(s.id);
    if (dry) continue;
    const body = noticeBody(existing.title, s.id, change);
    if (noticeOpen) {
      await updateArticle(noticeId, { body }, REFERENCE_ACTOR);
    } else {
      await createArticle(
        {
          id: noticeId,
          title: `Reference changed: ${existing.title}`,
          body,
          category: existing.category,
          tags: ["getsign", "reference", "site-change"],
          state: "draft",
          origin: existing.origin,
          source: existing.source,
          product: existing.product,
          createdBy: REFERENCE_ACTOR,
          meta: { revises: s.id },
        },
        { syncVector: false, checkDuplicates: false },
      );
    }
    await setSiteRecord(s.id, { text: rec.text, hash: rec.hash, pending: { text: s.body, hash } });
  }

  // Articles whose entry is gone from the file. `onRetired` decides.
  const current = new Set(sections.map((s) => s.id));
  for (const state of ["published", "draft", "in_review"] as const) {
    for (const a of await listArticles({ state, limit: 500 })) {
      if (a.origin !== "getsign-reference" || a.meta?.revises || current.has(a.id)) continue;
      const untouched = await machineOnly(a);
      const action = onRetired(a, untouched);
      res.retired.push({ id: a.id, action });
      if (dry || action === "leave") continue;
      if (action === "remove") {
        if (a.state === "published") await transitionState(a.id, "archived", REFERENCE_ACTOR);
        else if (untouched) await deleteArticle(a.id, REFERENCE_ACTOR);
        continue;
      }
      if (await getArticle(noticeIdFor(a.id))) continue;
      await createArticle(
        {
          id: noticeIdFor(a.id),
          title: `Reference dropped: ${a.title}`,
          body:
            `**The GetSign reference no longer has the section behind [${a.title}](/kb/article?id=${encodeURIComponent(a.id)}).**\n\n` +
            "The screen it describes may have been removed or renamed. Check the article is still true, " +
            "archive it if not, then mark this handled.",
          category: a.category,
          tags: ["getsign", "reference", "site-change"],
          state: "draft",
          origin: a.origin,
          source: a.source,
          product: a.product,
          createdBy: REFERENCE_ACTOR,
          meta: { revises: a.id },
        },
        { syncVector: false, checkDuplicates: false },
      );
    }
  }

  log.info("cron.kbsync_reference", { ...res, source: "cron" });
  return res;
}
