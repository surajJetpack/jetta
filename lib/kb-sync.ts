/**
 * Daily KB sync engine: mirror the support-relevant content of jetpackapps.io
 * and getsign.io (both open WordPress REST APIs) into the unified KB store.
 *
 * Per site: NEW pages are created as published articles (site content is
 * authoritative, same trust as the original seeds). CHANGED pages update
 * their article in place when no person has ever edited it; when one has —
 * or the article is hand-curated — the sync never overwrites it and instead
 * files a site-change notice in the KB review queue showing what changed on
 * the page. Pages REMOVED from the site archive their article (which drops it
 * from the vector index). Two guards bracket that: a
 * mass-DELETION guard skips archiving when a site returns suspiciously few
 * pages (outage protection), and a mass-CREATION guard skips ingesting when one
 * run would add a flood of them (a site turning a post type into programmatic
 * SEO).
 *
 * Used by the daily cron (app/api/cron/kb-sync) and the CLI (scripts/kb-sync.ts).
 */
import crypto from "node:crypto";
import { diffWords } from "diff";
import {
  getArticle,
  createArticle,
  updateArticle,
  deleteArticle,
  transitionState,
  upsertCategory,
  listArticles,
  listVersions,
  getSiteRecord,
  setSiteRecord,
  type KbArticle,
  type ArticleOrigin,
} from "./kb-store";
import { log } from "./logger";

const SYNC_ACTOR = "kb-sync";
/**
 * Actors whose edits don't count as human (safe to overwrite from the site).
 *
 * Machine backfills belong here too: a one-off that stamps a field on every
 * article would otherwise mark the whole crawled corpus as human-edited and
 * quietly stop the daily sync from ever updating it again.
 */
const CRAWLER_ACTORS = new Set([SYNC_ACTOR, "kb-crawl-jetpackapps", "kb-migrate", "kb-scope-backfill"]);
/**
 * Body cap. Was 8000, which cut the GetSign MCP pages (10–13k chars) before
 * their FAQ — usually the part that answers the customer's actual question.
 * The agent reads full bodies for only its top 3 hits, so the cost stays
 * bounded.
 */
const BODY_CHARS = 16000;
const MIN_BODY_CHARS = 200;
/**
 * A hand-written article gets a site-change notice only when at least this
 * many words changed on its page. Below it — a fixed typo, a reworded button —
 * the new page text quietly becomes the baseline.
 */
const NOTICE_MIN_WORDS = 12;
/** Archive guard: skip archiving when the site returns < this share of stored articles. */
const MASS_DELETE_GUARD = 0.7;
/**
 * Creation guard: skip creating when ONE run would add more than this many
 * articles.
 *
 * The mirror of MASS_DELETE_GUARD, and the lesson of the getsign redesign. A
 * marketing site can grow a post type by 1380 pages overnight — programmatic
 * SEO is designed to do exactly that — and this sync auto-publishes new pages
 * straight into the vector index. There was a brake on mass deletion and none
 * on mass creation, which is the wrong way round: deleting is recoverable from
 * version snapshots, whereas drowning the retrieval corpus degrades every
 * answer until someone notices.
 *
 * Flag and let a human decide; `allowBulk` is the deliberate override.
 */
const MASS_CREATE_GUARD = 40;

export interface SiteConfig {
  key: "jetpackapps" | "getsign";
  base: string;
  origin: ArticleOrigin;
  source: string;
  postTypes: string[];
  denylist: RegExp[];
  categories: { slug: string; name: string }[];
  categoryForUrl: (url: string) => string;
  /**
   * Auto-apply body/title updates to the site's SEEDED articles. False for
   * getsign: its seed corpus is hand-curated and measurably better than
   * crawler-extracted text (the 2026-07-12 catch-up sync dropped getsign MRR
   * 0.987→0.777 and was rolled back).
   *
   * Articles this sync created itself are crawler text to begin with, so they
   * always follow their page — that holds even when this is false. (Until
   * 2026-10-10 it didn't: the MCP pages were ingested on 09-30 and then went
   * on answering from their 09-29 text, saying GetSign had no Claude plugin a
   * week after the site said it did.)
   */
  autoUpdate: boolean;
}

export const SITES: SiteConfig[] = [
  {
    key: "jetpackapps",
    base: "https://jetpackapps.io",
    origin: "seed-jetpackapps",
    source: "jetpackapps.io",
    postTypes: ["getting-started-post", "how-tos", "tutorial", "resources", "solution", "posts", "pages"],
    autoUpdate: true,
    denylist: [
      /^\/$/,
      /thank-you/,
      /contact-us/,
      /about-us/,
      /partners/,
      /chat-with-us/,
      /support-chat/,
      /^\/resources\/$/,
      /^\/solutions\/$/,
      /%resources%/,
    ],
    categories: [
      { slug: "jpa-trackmy", name: "TrackMy" },
      { slug: "jpa-vlookup", name: "VLOOKUP Auto-Link" },
      { slug: "jpa-extract-ai", name: "Extract AI" },
      { slug: "jpa-jobflows", name: "JobFlows" },
      { slug: "jpa-smart-columns", name: "Smart Columns" },
      { slug: "jpa-jetscan-hr", name: "JetScan HR" },
      { slug: "jpa-pivot-reports", name: "Pivot Reports Pro" },
      { slug: "jpa-triggerly", name: "Triggerly" },
      { slug: "jpa-general", name: "Jetpack Apps — General" },
    ],
    categoryForUrl(url: string): string {
      const path = url.replace(/https?:\/\/[^/]+/, "").toLowerCase();
      if (/trackmy/.test(path)) return "jpa-trackmy";
      if (/vlookup/.test(path)) return "jpa-vlookup";
      if (/extract|email-to-monday/.test(path)) return "jpa-extract-ai";
      if (/jobflows/.test(path)) return "jpa-jobflows";
      if (/smart-column|smart-columns|smart-embed|smart-mirror|smart-sla|custom-item-id|currency-converter|unformula|conditional-status|formatted-numbers|mandatory-fields|copy-paste|special-dates|duplicates|phone-verification|360-view/.test(path))
        return "jpa-smart-columns";
      if (/jetscan/.test(path)) return "jpa-jetscan-hr";
      if (/pivot/.test(path)) return "jpa-pivot-reports";
      if (/triggerly|qr-/.test(path)) return "jpa-triggerly";
      return "jpa-general";
    },
  },
  {
    key: "getsign",
    base: "https://getsign.io",
    origin: "seed-getsign",
    source: "getsign.io",
    /*
     * `workflow` and `form` are deliberately NOT crawled.
     *
     * The site redesign turned both into programmatic SEO surfaces: 1380
     * /workflow/ pages and 488 /form/ pages, against a getsign corpus of ~80
     * curated articles. They are template/landing permutations, not support
     * content — ingesting them would bury the answers Jetta needs under an
     * order of magnitude of near-duplicate text.
     *
     * Nothing has actually been ingested: these are page-builder pages whose
     * WP REST `content.rendered` is EMPTY (verified across 100 of each), so
     * MIN_BODY_CHARS already dropped every one. That is the point. The only
     * thing standing between the retrieval corpus and 500 junk articles (the
     * fetchType page cap) was an incidental 200-character filter, and whether
     * a page builder populates `content.rendered` is a WordPress plugin
     * setting nobody here controls. Excluding the post types makes it a
     * decision instead of an accident — and stops fetching 500 empty records
     * every morning.
     *
     * `workflow` used to be in this list, from when the post type held a
     * handful of real pages. `form` never was, and must not be added.
     */
    postTypes: ["getting-started", "how-tos", "tutorial", "posts", "pages"],
    autoUpdate: false,
    denylist: [
      /^\/$/,
      /thank-you/,
      /contact/,
      /about/,
      /privacy|terms|legal/,
      /pricing\/?$/,
      /book-a-session/,
      // The page that embeds the JettaChat widget: its text is the widget's own
      // greeting, which then came back as a "KB article".
      /support-chat/,
      // Belt and braces for the two post types above: this also catches them
      // if they ever surface under `pages`/`posts` instead of their own type.
      /^\/workflow\//,
      /^\/form\//,
    ],
    // Same category slugs kb-migrate registered for the original seed.
    categories: [
      { slug: "getsign-features", name: "GetSign — Features" },
      { slug: "getsign-getting-started", name: "GetSign — Getting Started" },
      { slug: "getsign-capabilities", name: "GetSign — Capabilities" },
      { slug: "getsign-how-tos", name: "GetSign — How-tos" },
      { slug: "getsign-workflows", name: "GetSign — Workflows" },
      { slug: "getsign-general", name: "GetSign — General" },
    ],
    categoryForUrl(url: string): string {
      if (url.includes("/feature/")) return "getsign-features";
      if (url.includes("/getting-started/")) return "getsign-getting-started";
      if (url.includes("/capabilities/")) return "getsign-capabilities";
      if (url.includes("/how-tos/")) return "getsign-how-tos";
      if (url.includes("/workflow/")) return "getsign-workflows";
      return "getsign-general";
    },
  },
];

export const slug = (s: string) =>
  s.toLowerCase().replace(/https?:\/\//, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 120);

/**
 * Text shape used to decide "did the page change": case, whitespace and
 * typography folded, so a redesign that swaps straight quotes for curly ones
 * (the 2026 getsign redesign did exactly this) isn't a change.
 */
function normalizeForCompare(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201f]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export function pageHash(title: string, body: string): string {
  return crypto.createHash("sha1").update(normalizeForCompare(`${title}\n${body}`)).digest("hex");
}

interface PageChange {
  /** Words added + removed, typography and whitespace ignored. */
  words: number;
  added: string[];
  removed: string[];
}

/** What changed between two versions of a page's text, as reviewable passages. */
export function describeChange(before: string, after: string): PageChange {
  const fold = (t: string) => t.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, " ").trim();
  const change: PageChange = { words: 0, added: [], removed: [] };
  for (const part of diffWords(fold(before), fold(after), { ignoreCase: true })) {
    if (!part.added && !part.removed) continue;
    const text = part.value.trim();
    const n = text.split(/\s+/).filter(Boolean).length;
    change.words += n;
    if (n < 3) continue; // single-word swaps count toward the total but aren't worth a passage
    const passage = text.length > 400 ? `${text.slice(0, 400)}…` : text;
    (part.added ? change.added : change.removed).push(passage);
  }
  return change;
}

/** Rendered WP HTML → plain text (same posture as the original seed corpora). */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
    .replace(/&#8211;|&ndash;|&#8212;|&mdash;/g, "—")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

function keywordsFromTitle(title: string): string[] {
  const stop = new Set(["the", "and", "for", "with", "how", "your", "from", "into", "using", "monday", "com", "on", "in", "to", "a", "of"]);
  return [...new Set(title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !stop.has(w)))].slice(0, 12);
}

function decodeEntities(s: string): string {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&");
}

interface WpPost {
  title: { rendered: string };
  link: string;
  modified: string;
  content: { rendered: string };
}

async function fetchType(base: string, type: string): Promise<WpPost[]> {
  const out: WpPost[] = [];
  for (let page = 1; page <= 5; page++) {
    const res = await fetch(
      `${base}/wp-json/wp/v2/${type}?per_page=100&page=${page}&_fields=title,link,content,modified`,
    );
    if (res.status === 400) break; // past the last page
    if (!res.ok) throw new Error(`${type} page ${page}: HTTP ${res.status}`);
    const batch = (await res.json()) as WpPost[];
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

/** A crawled, filtered site page ready to diff against the store. */
interface SitePage {
  url: string;
  title: string;
  body: string;
  modified: string;
}

async function crawlSite(site: SiteConfig): Promise<SitePage[]> {
  const pages: SitePage[] = [];
  const seen = new Set<string>();
  for (const type of site.postTypes) {
    for (const p of await fetchType(site.base, type)) {
      const path = p.link.replace(/https?:\/\/[^/]+/, "");
      if (seen.has(p.link) || site.denylist.some((re) => re.test(path))) continue;
      const body = htmlToText(p.content.rendered).slice(0, BODY_CHARS);
      if (body.length < MIN_BODY_CHARS) continue;
      seen.add(p.link);
      pages.push({ url: p.link, title: decodeEntities(p.title.rendered.trim()), body, modified: p.modified });
    }
  }
  return pages;
}

export interface SyncResult {
  site: string;
  crawled: number;
  created: number;
  /** New pages the creation guard held back, awaiting a human decision. */
  skippedNew: number;
  updated: number;
  archived: number;
  /** Pages whose site-change notice was filed or refreshed in the review queue. */
  noticed: string[];
  /** Hand-written articles seen for the first time — page text recorded as their baseline. */
  baselined: number;
  /** Run-level problems (guards tripped, unreachable pages) — logged at warn. */
  flagged: string[];
}

/**
 * True when no person has ever written this article's content.
 *
 * Reads the version history, not just `updatedBy`: machine backfills
 * (kb-scope-backfill) restamp `updatedBy` on every article, which made a
 * human-edited article look untouched whenever a backfill ran after the human.
 */
async function machineOnly(a: KbArticle): Promise<boolean> {
  if (!CRAWLER_ACTORS.has(a.updatedBy ?? a.createdBy) || !CRAWLER_ACTORS.has(a.createdBy)) return false;
  if (a.version === 1) return true;
  const versions = await listVersions(a.id);
  return versions.every((v) => CRAWLER_ACTORS.has(v.editedBy));
}

const noticeIdFor = (articleId: string) => `${articleId}--site-change`;

function noticeBody(site: SiteConfig, article: KbArticle, pageUrl: string, change: PageChange): string {
  const quote = (ps: string[]) =>
    ps.slice(0, 8).map((x) => `> ${x.replace(/\n+/g, " ")}`).join("\n\n") +
    (ps.length > 8 ? `\n\n…and ${ps.length - 8} more` : "");
  return [
    `**${site.source} changed the page behind [${article.title}](/kb/article?id=${encodeURIComponent(article.id)}).**`,
    "",
    `Jetta still answers from the article as written — the sync never overwrites a hand-written article. ` +
      `If anything below changes the answer, edit the article; then mark this handled.`,
    "",
    `Page: ${pageUrl} · about ${change.words} words changed`,
    ...(change.added.length ? ["", "### Now on the page", "", quote(change.added)] : []),
    ...(change.removed.length ? ["", "### No longer on the page", "", quote(change.removed)] : []),
  ].join("\n");
}

export async function syncSite(
  site: SiteConfig,
  opts: { dryRun?: boolean; allowBulk?: boolean } = {},
): Promise<SyncResult> {
  const dry = opts.dryRun === true;
  const res: SyncResult = {
    site: site.key,
    crawled: 0,
    created: 0,
    skippedNew: 0,
    updated: 0,
    archived: 0,
    noticed: [],
    baselined: 0,
    flagged: [],
  };

  const pages = await crawlSite(site);
  res.crawled = pages.length;
  const byUrl = new Map(pages.map((p) => [p.url, p]));

  // Load the whole store once and index by URL (all states — a human-archived
  // article must not be re-created, a draft must not be duplicated).
  const stored: KbArticle[] = [];
  for (const state of ["published", "draft", "in_review", "archived"] as const) {
    stored.push(...(await listArticles({ state, limit: 500 })));
  }
  // `stored` runs published → archived, so keep the FIRST article per url: when
  // a page has an archived predecessor and a live article, the live one is the
  // article the page belongs to.
  const storedByUrl = new Map<string, KbArticle>();
  for (const a of stored) if (a.url && !storedByUrl.has(a.url)) storedByUrl.set(a.url, a);
  const storedById = new Map(stored.map((a) => [a.id, a]));
  const t = Math.floor(Date.now() / 1000);

  if (!dry) for (const c of site.categories) await upsertCategory(c);

  // ── New + changed ──
  const newPages = pages.filter((p) => !storedByUrl.has(p.url));
  const holdNew = !opts.allowBulk && newPages.length > MASS_CREATE_GUARD;
  if (holdNew) {
    res.flagged.push(
      `${newPages.length} new pages in one run (guard: ${MASS_CREATE_GUARD}) — creation SKIPPED. ` +
        `Check whether they belong in the KB, then re-run with --allow-bulk. ` +
        `Examples: ${newPages.slice(0, 5).map((p) => p.url).join(", ")}`,
    );
  }

  for (const p of pages) {
    const existing = storedByUrl.get(p.url);
    if (!existing) {
      if (holdNew) {
        res.skippedNew++;
        continue;
      }
      res.created++;
      if (dry) continue;
      // Guard against id collisions with legacy slug(url)-i ids.
      const id = (await getArticle(slug(p.url))) ? `${slug(p.url)}-sync` : slug(p.url);
      await createArticle(
        {
          id,
          title: p.title,
          url: p.url,
          body: p.body,
          keywords: keywordsFromTitle(p.title),
          category: site.categoryForUrl(p.url),
          tags: [site.key],
          state: "published",
          origin: site.origin,
          source: site.source,
          createdBy: SYNC_ACTOR,
          reviewBy: t + 180 * 86400,
          meta: { wpModified: p.modified },
        },
        { syncVector: true, checkDuplicates: false },
      );
      continue;
    }

    // Sync-owned: the article IS crawler text, so it follows its page.
    if ((site.autoUpdate || existing.createdBy === SYNC_ACTOR) && (await machineOnly(existing))) {
      if (existing.body === p.body && existing.title === p.title) continue;
      res.updated++;
      if (dry) continue;
      await updateArticle(
        existing.id,
        { title: p.title, body: p.body, keywords: keywordsFromTitle(p.title), meta: { wpModified: p.modified } },
        SYNC_ACTOR,
      );
      continue;
    }

    // Hand-written (curated seed, or a person edited it): never overwritten.
    // Compare the page against what it said last time we looked, and if it
    // really changed, put a notice in the review queue saying what changed.
    // Nothing here writes to the article itself — see SiteRecord for why.
    const hash = pageHash(p.title, p.body);
    let rec = await getSiteRecord(existing.id);
    const noticeOpen = storedById.has(noticeIdFor(existing.id));
    if (rec?.pending && !noticeOpen) {
      // The last notice was handled: what it asked about is now the baseline.
      rec = { text: rec.pending.text, hash: rec.pending.hash };
      if (!dry) await setSiteRecord(existing.id, rec);
    }
    if (!rec) {
      res.baselined++;
      if (!dry) await setSiteRecord(existing.id, { text: p.body, hash });
      continue;
    }
    if (hash === (rec.pending?.hash ?? rec.hash)) continue; // nothing new since we last looked

    const change = describeChange(rec.text, p.body);
    if (change.words < NOTICE_MIN_WORDS) {
      // Cosmetic, or the page went back to what the reviewer last saw.
      if (dry) continue;
      await setSiteRecord(existing.id, { text: p.body, hash });
      if (noticeOpen) await deleteArticle(noticeIdFor(existing.id), SYNC_ACTOR);
      continue;
    }
    res.noticed.push(p.url);
    if (dry) continue;
    const body = noticeBody(site, existing, p.url, change);
    if (noticeOpen) {
      await updateArticle(noticeIdFor(existing.id), { body }, SYNC_ACTOR);
    } else {
      await createArticle(
        {
          id: noticeIdFor(existing.id),
          title: `Site changed: ${existing.title}`,
          // No url: the sync indexes the store by url, and a notice must never
          // be mistaken for the page's article.
          body,
          category: existing.category,
          tags: [site.key, "site-change"],
          state: "draft",
          origin: existing.origin,
          source: existing.source,
          product: existing.product,
          createdBy: SYNC_ACTOR,
          meta: { revises: existing.id },
        },
        { syncVector: false, checkDuplicates: false },
      );
    }
    await setSiteRecord(existing.id, { text: rec.text, hash: rec.hash, pending: { text: p.body, hash } });
  }

  // ── Removed from the site → archive, but only on a confirmed 404/410 ──
  // "Not in the crawl" is NOT proof of removal: denylisted pages and content
  // outside the crawled post types (e.g. getsign /capabilities/) never appear
  // in the crawl yet still exist. A HEAD request decides.
  const siteArticles = stored.filter((a) => a.origin === site.origin && a.state === "published");
  if (pages.length < siteArticles.length * MASS_DELETE_GUARD) {
    res.flagged.push(
      `site returned only ${pages.length} pages vs ${siteArticles.length} stored — skipping archiving (outage guard)`,
    );
  } else {
    for (const a of siteArticles) {
      if (!a.url || byUrl.has(a.url)) continue;
      const status = await fetch(a.url, { method: "HEAD", redirect: "follow" })
        .then((r) => r.status)
        .catch(() => 0);
      if (status === 404 || status === 410) {
        res.archived++;
        if (!dry) await transitionState(a.id, "archived", SYNC_ACTOR);
      } else if (status === 0) {
        res.flagged.push(`unreachable while checking removal (kept): ${a.url}`);
      }
      // 2xx/3xx → page still exists outside the crawl scope; leave it alone.
    }
  }

  // warn when something needs a person: a guard tripped or a page was unreachable.
  // Site changes don't count — they're already waiting in the review queue.
  (res.flagged.length ? log.warn : log.info)("cron.kbsync_run", { ...res, source: "cron" });
  return res;
}
