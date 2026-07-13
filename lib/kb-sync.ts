/**
 * Daily KB sync engine: mirror the support-relevant content of jetpackapps.io
 * and getsign.io (both open WordPress REST APIs) into the unified KB store.
 *
 * Per site: NEW pages are created as published articles (site content is
 * authoritative, same trust as the original seeds); CHANGED pages are updated
 * only when the stored article was never human-edited (human edits win, same
 * principle as kb-migrate); pages REMOVED from the site archive their article
 * (which drops it from the vector index). A mass-deletion guard skips all
 * archiving when a site returns suspiciously few pages (outage protection).
 *
 * Used by the daily cron (app/api/cron/kb-sync) and the CLI (scripts/kb-sync.ts).
 */
import {
  getArticle,
  createArticle,
  updateArticle,
  transitionState,
  upsertCategory,
  listArticles,
  type KbArticle,
  type ArticleOrigin,
} from "./kb-store";
import { log } from "./logger";

const SYNC_ACTOR = "kb-sync";
/** Actors whose edits don't count as human (safe to overwrite from the site). */
const CRAWLER_ACTORS = new Set([SYNC_ACTOR, "kb-crawl-jetpackapps", "kb-migrate"]);
const BODY_CHARS = 8000;
const MIN_BODY_CHARS = 200;
/** Archive guard: skip archiving when the site returns < this share of stored articles. */
const MASS_DELETE_GUARD = 0.7;

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
   * Auto-apply body/title updates from the site. False for getsign: its corpus
   * is hand-curated and measurably better than crawler-extracted text (the
   * 2026-07-12 catch-up sync dropped getsign MRR 0.987→0.777 and was rolled
   * back) — changed pages get flagged for manual review instead.
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
    postTypes: ["getting-started", "how-tos", "tutorial", "workflow", "posts", "pages"],
    autoUpdate: false,
    denylist: [
      /^\/$/,
      /thank-you/,
      /contact/,
      /about/,
      /privacy|terms|legal/,
      /pricing\/?$/,
      /book-a-session/,
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
  updated: number;
  archived: number;
  skippedHumanEdited: string[];
  flagged: string[];
}

/** True when the article has only ever been touched by crawlers/seeds. */
function neverHumanEdited(a: KbArticle): boolean {
  return CRAWLER_ACTORS.has(a.updatedBy ?? a.createdBy) || (a.version === 1 && CRAWLER_ACTORS.has(a.createdBy));
}

export async function syncSite(site: SiteConfig, opts: { dryRun?: boolean } = {}): Promise<SyncResult> {
  const dry = opts.dryRun === true;
  const res: SyncResult = {
    site: site.key,
    crawled: 0,
    created: 0,
    updated: 0,
    archived: 0,
    skippedHumanEdited: [],
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
  const storedByUrl = new Map(stored.filter((a) => a.url).map((a) => [a.url, a]));
  const t = Math.floor(Date.now() / 1000);

  if (!dry) for (const c of site.categories) await upsertCategory(c);

  // ── New + changed ──
  for (const p of pages) {
    const existing = storedByUrl.get(p.url);
    if (!existing) {
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

    const changed =
      (existing.meta?.wpModified ?? "") !== p.modified &&
      (existing.body !== p.body || existing.title !== p.title);
    if (!changed) continue;
    if (!site.autoUpdate) {
      // Curated corpus (getsign): never overwrite automatically — surface for
      // manual review. Only flag when WP says the page ACTUALLY changed since
      // we last looked (stamp wpModified once so this doesn't re-flag daily).
      if ((existing.meta?.wpModified ?? "") === "") {
        if (!dry) await updateArticle(existing.id, { meta: { wpModified: p.modified } }, SYNC_ACTOR);
      } else {
        res.flagged.push(`changed on site (manual review): ${p.url}`);
      }
      continue;
    }
    if (!neverHumanEdited(existing)) {
      res.skippedHumanEdited.push(p.url);
      continue;
    }
    res.updated++;
    if (dry) continue;
    await updateArticle(
      existing.id,
      { title: p.title, body: p.body, keywords: keywordsFromTitle(p.title), meta: { wpModified: p.modified } },
      SYNC_ACTOR,
    );
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

  log.info("cron.kbsync_run", { ...res, skippedHumanEdited: res.skippedHumanEdited.length, source: "cron" });
  return res;
}
