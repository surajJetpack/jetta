/**
 * Crawl jetpackapps.io via the WordPress REST API into the unified KB store.
 *
 * Pulls the support-relevant post types (getting-started, how-tos, tutorials,
 * resources, solutions, posts, curated pages), strips the rendered HTML to
 * plain text, and seeds them as published articles with origin
 * "seed-jetpackapps" and per-app categories. The `trackmy` post type (1,600
 * programmatic per-courier SEO pages) is intentionally excluded — it would
 * pollute retrieval with near-duplicate content.
 *
 * Idempotent: ids derive from the page URL and existing articles are never
 * overwritten (human edits win). Re-run any time content changes, then run
 * scripts/kb-ingest.ts (or console bulk reingest) to refresh the vector index.
 *
 *   npx tsx --env-file=.env.local scripts/kb-crawl-jetpackapps.ts [--dry-run]
 */
import { getArticle, createArticle, upsertCategory, type NewArticle } from "../lib/kb-store";

const DRY = process.argv.includes("--dry-run");
const BASE = "https://jetpackapps.io";
const BODY_CHARS = 8000;

/** REST bases to crawl (custom post types verified via /wp-json/wp/v2/types). */
const POST_TYPES = [
  "getting-started-post",
  "how-tos",
  "tutorial",
  "resources",
  "solution",
  "posts",
  "pages",
];

/** Non-support pages (matched against the URL path) to skip. */
const DENYLIST = [
  /^\/$/,
  /thank-you/,
  /contact-us/,
  /about-us/,
  /partners/,
  /chat-with-us/,
  /^\/resources\/$/,
  /^\/solutions\/$/,
  /%resources%/,
];

const CATEGORIES = [
  { slug: "jpa-trackmy", name: "TrackMy" },
  { slug: "jpa-vlookup", name: "VLOOKUP Auto-Link" },
  { slug: "jpa-extract-ai", name: "Extract AI" },
  { slug: "jpa-jobflows", name: "JobFlows" },
  { slug: "jpa-smart-columns", name: "Smart Columns" },
  { slug: "jpa-jetscan-hr", name: "JetScan HR" },
  { slug: "jpa-pivot-reports", name: "Pivot Reports Pro" },
  { slug: "jpa-triggerly", name: "Triggerly" },
  { slug: "jpa-general", name: "Jetpack Apps — General" },
];

/** Map a page URL to an app category via its path. */
function categoryForUrl(url: string): string {
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
  if (/getsign/.test(path)) return "jpa-general"; // getsign landing on jetpackapps.io — keep, generic
  return "jpa-general";
}

const slug = (s: string) =>
  s.toLowerCase().replace(/https?:\/\//, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 120);

/** Rendered WP HTML → plain text (same posture as the getsign corpus). */
function htmlToText(html: string): string {
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

interface WpPost {
  title: { rendered: string };
  link: string;
  content: { rendered: string };
}

async function fetchType(type: string): Promise<WpPost[]> {
  const out: WpPost[] = [];
  for (let page = 1; page <= 5; page++) {
    const res = await fetch(
      `${BASE}/wp-json/wp/v2/${type}?per_page=100&page=${page}&_fields=title,link,content`,
    );
    if (res.status === 400) break; // past the last page
    if (!res.ok) throw new Error(`${type} page ${page}: HTTP ${res.status}`);
    const batch = (await res.json()) as WpPost[];
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

function decodeEntities(s: string): string {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&");
}

async function main() {
  console.log(`jetpackapps.io crawl ${DRY ? "(DRY RUN — nothing written)" : ""}\n`);
  const t = Math.floor(Date.now() / 1000);
  const counts = { created: 0, skipped: 0, denied: 0, empty: 0 };
  const perCategory: Record<string, number> = {};

  if (!DRY) for (const c of CATEGORIES) await upsertCategory(c);

  for (const type of POST_TYPES) {
    const posts = await fetchType(type);
    console.log(`${type}: ${posts.length} fetched`);
    for (const p of posts) {
      const path = p.link.replace(/https?:\/\/[^/]+/, "");
      if (DENYLIST.some((re) => re.test(path))) {
        counts.denied++;
        continue;
      }
      const body = htmlToText(p.content.rendered).slice(0, BODY_CHARS);
      if (body.length < 200) {
        counts.empty++;
        if (DRY) console.log(`  SKIP (thin, ${body.length} chars): ${path}`);
        continue;
      }
      const title = decodeEntities(p.title.rendered.trim());
      const category = categoryForUrl(p.link);
      perCategory[category] = (perCategory[category] ?? 0) + 1;
      const id = slug(p.link);

      if (DRY) {
        console.log(`  ${id}  [${category}]  ${title}  (${body.length} chars)`);
        counts.created++;
        continue;
      }

      const article: NewArticle = {
        id,
        title,
        url: p.link,
        body,
        keywords: keywordsFromTitle(title),
        category,
        tags: [category.replace(/^jpa-/, "")],
        state: "published",
        origin: "seed-jetpackapps",
        source: "jetpackapps.io",
        createdBy: "kb-crawl-jetpackapps",
        reviewBy: t + 180 * 86400,
      };
      const existing = await getArticle(id);
      if (existing) {
        counts.skipped++;
      } else {
        await createArticle(article, { syncVector: false, checkDuplicates: false });
        counts.created++;
      }
    }
  }

  console.log(`\n${DRY ? "Would create" : "Created"}: ${counts.created} | skipped (existing): ${counts.skipped} | denied: ${counts.denied} | thin: ${counts.empty}`);
  console.log("Per category:", JSON.stringify(perCategory, null, 2));
  if (!DRY) console.log("\nNext: npx tsx --env-file=.env.local scripts/kb-ingest.ts to rebuild the vector index.");
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
