/**
 * Build the publishable manual from docs/manual/README.md.
 *
 * The markdown is the single source of truth — it renders on GitHub with
 * relative image paths, and this script turns the same file into one
 * self-contained HTML page with every screenshot inlined as a data URI (the
 * Artifact CSP blocks external hosts, so nothing can be linked).
 *
 *   node scripts/manual-build.mjs [--src f.md] [--images dir] [--out f.html] [--title "…"]
 *
 * Defaults build the full admin manual; pass the flags to build the
 * general-user one from docs/manual/general.md + images-general.
 *
 * Design tokens live in CSS below; content lives in the markdown. Keep it that
 * way — a manual maintained in two places goes stale in the copy fewer people
 * read.
 */
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";
import { readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

/** Minimal --flag value parser; positional arg 0 still works as --out. */
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const resolve = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));

const SRC = resolve(arg("src", "docs/manual/README.md"));
const IMAGES = resolve(arg("images", "docs/manual/images"));
const OUT = resolve(arg("out", process.argv[2]?.startsWith("--") ? "docs/manual/manual.html" : (process.argv[2] ?? "docs/manual/manual.html")));
const TITLE = arg("title", "The Jetta Manual");

const CSS = `
:root {
  /* Cool neutrals with a teal bias, so the page sits beside 25 light-mode
     console screenshots instead of fighting them. */
  --ground: #f6f7f8;
  --surface: #ffffff;
  --ink: #16202a;
  --muted: #5c6a76;
  --rule: #dfe4e8;
  --accent: #12706a;
  --accent-soft: #e6f1f0;
  --warn-ink: #7d4906;
  --warn-bg: #fdf3e3;
  --stop-ink: #a32b21;
  --stop-bg: #fbebe9;
  --shadow: 0 1px 2px rgb(22 32 42 / 6%), 0 8px 24px rgb(22 32 42 / 6%);

  --serif: ui-serif, "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
  --sans: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --ground: #10161b;
    --surface: #171f26;
    --ink: #e6edf1;
    --muted: #93a3af;
    --rule: #27333c;
    --accent: #4fbfb2;
    --accent-soft: #14312f;
    --warn-ink: #e0a75a;
    --warn-bg: #2b2114;
    --stop-ink: #e88b7e;
    --stop-bg: #2e1a17;
    --shadow: 0 1px 2px rgb(0 0 0 / 40%), 0 8px 24px rgb(0 0 0 / 30%);
  }
}
:root[data-theme="dark"] {
  --ground: #10161b;
  --surface: #171f26;
  --ink: #e6edf1;
  --muted: #93a3af;
  --rule: #27333c;
  --accent: #4fbfb2;
  --accent-soft: #14312f;
  --warn-ink: #e0a75a;
  --warn-bg: #2b2114;
  --stop-ink: #e88b7e;
  --stop-bg: #2e1a17;
  --shadow: 0 1px 2px rgb(0 0 0 / 40%), 0 8px 24px rgb(0 0 0 / 30%);
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--ground);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 17px;
  line-height: 1.65;
  -webkit-font-smoothing: antialiased;
}

.layout {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0;
  max-width: 1180px;
  margin: 0 auto;
  padding: 0 24px 120px;
}
@media (min-width: 1080px) {
  .layout { grid-template-columns: 210px minmax(0, 1fr); gap: 56px; }
}

/* Contents rail — hidden on narrow screens where it would just be a wall.
   Hiding is a max-width query rather than a base display:none that a later
   min-width rule has to out-order: with the rail hidden, the grid places main
   in the FIRST column, squeezing the whole document into the 210px rail. */
nav.toc { padding-top: 96px; }
@media (max-width: 1079.98px) {
  nav.toc { display: none; }
}
nav.toc .inner { position: sticky; top: 40px; }
nav.toc h2 {
  font-family: var(--sans);
  font-size: 11px;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--muted);
  margin: 0 0 12px;
  font-weight: 600;
}
nav.toc ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
nav.toc a {
  display: flex;
  gap: 9px;
  padding: 4px 0;
  font-size: 13.5px;
  color: var(--muted);
  text-decoration: none;
  line-height: 1.4;
}
nav.toc a:hover { color: var(--accent); }
nav.toc .n { font-family: var(--mono); font-size: 11px; padding-top: 2px; opacity: 0.7; font-variant-numeric: tabular-nums; }

main { min-width: 0; padding-top: 88px; }

/* Running text stays near 65 characters; figures break out wider. */
main > *:not(figure):not(.wide) { max-width: 34em; }

h1 {
  font-family: var(--serif);
  font-size: clamp(38px, 5.2vw, 54px);
  line-height: 1.06;
  letter-spacing: -0.02em;
  font-weight: 600;
  margin: 0 0 20px;
  text-wrap: balance;
}
h1 + p { font-size: 19px; color: var(--muted); }

h2 {
  font-family: var(--serif);
  font-size: 29px;
  line-height: 1.2;
  letter-spacing: -0.012em;
  font-weight: 600;
  margin: 72px 0 18px;
  text-wrap: balance;
  scroll-margin-top: 24px;
}
/* The chapter number is set off as an eyebrow: the manual really is a
   sequence, so the numbering carries information. */
h2 .n {
  display: block;
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.12em;
  color: var(--accent);
  margin-bottom: 10px;
  font-variant-numeric: tabular-nums;
}
h3 {
  font-family: var(--sans);
  font-size: 16px;
  font-weight: 650;
  letter-spacing: 0.005em;
  margin: 44px 0 10px;
  text-wrap: balance;
}

p { margin: 0 0 16px; }
strong { font-weight: 650; }
a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 2px; }
a:focus-visible, nav.toc a:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 2px; }

ul, ol { margin: 0 0 16px; padding-left: 22px; }
li { margin: 6px 0; }
li::marker { color: var(--muted); }

code {
  font-family: var(--mono);
  font-size: 0.86em;
  background: var(--accent-soft);
  color: var(--ink);
  padding: 1.5px 5px;
  border-radius: 4px;
}
pre {
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 8px;
  padding: 14px 16px;
  overflow-x: auto;
  margin: 0 0 16px;
}
pre code { background: none; padding: 0; font-size: 13px; }

/* The one-rule callout and any other blockquote. */
blockquote {
  margin: 0 0 20px;
  padding: 16px 20px;
  background: var(--accent-soft);
  border-left: 3px solid var(--accent);
  border-radius: 0 8px 8px 0;
}
blockquote p:last-child { margin-bottom: 0; }

hr {
  border: 0;
  border-top: 1px solid var(--rule);
  margin: 64px 0 0;
}

figure {
  margin: 26px 0 30px;
  max-width: 100%;
}
figure img {
  display: block;
  width: 100%;
  height: auto;
  border: 1px solid var(--rule);
  border-radius: 10px;
  box-shadow: var(--shadow);
  background: var(--surface);
}
figcaption {
  margin-top: 10px;
  font-size: 13px;
  color: var(--muted);
  font-family: var(--sans);
  max-width: 34em;
}

/* .wide opts out of the 34em prose clamp; tables need more room than text. */
.table-wrap { overflow-x: auto; margin: 0 0 20px; max-width: 46em; }
table { border-collapse: collapse; width: 100%; font-size: 15px; }
th, td { text-align: left; padding: 9px 14px 9px 0; border-bottom: 1px solid var(--rule); vertical-align: top; }
th {
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
  font-weight: 600;
  border-bottom-color: var(--ink);
}

/* Gaps the harness can't fill — Freshdesk and Slack screens. */
.placeholder {
  margin: 24px 0 28px;
  padding: 22px;
  border: 1px dashed var(--rule);
  border-radius: 10px;
  background: var(--surface);
  color: var(--muted);
  font-size: 14px;
  font-family: var(--mono);
  line-height: 1.5;
}

footer.colophon {
  margin-top: 80px;
  padding-top: 22px;
  border-top: 1px solid var(--rule);
  font-size: 13px;
  color: var(--muted);
  max-width: 34em;
}

@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
}
`;

/** Inline every referenced screenshot; a linked file would be blocked. */
async function inlineImages(html) {
  const misses = [];
  let bytes = 0;
  const out = await replaceAsync(html, /<img src="[^"]*?([^"\/]+\.(?:webp|png|jpe?g))" alt="([^"]*)"\s*\/?>/g, async (_m, file, alt) => {
    const abs = path.join(IMAGES, file);
    try {
      await stat(abs);
    } catch {
      misses.push(file);
      return `<div class="placeholder">Missing image: ${file}</div>`;
    }
    const buf = await readFile(abs);
    bytes += buf.length;
    const mime = file.endsWith(".png") ? "image/png" : file.endsWith(".webp") ? "image/webp" : "image/jpeg";
    return `<img src="data:${mime};base64,${buf.toString("base64")}" alt="${alt}" loading="lazy">`;
  });
  return { html: out, misses, bytes };
}

/** String.replace with an async replacer. */
async function replaceAsync(str, re, fn) {
  const jobs = [];
  str.replace(re, (...args) => {
    jobs.push(fn(...args));
    return "";
  });
  const done = await Promise.all(jobs);
  let i = 0;
  return str.replace(re, () => done[i++]);
}

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const slug = (s) =>
  s.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");

async function main() {
  const md = await readFile(SRC, "utf8");
  let html = micromark(md, {
    allowDangerousHtml: true,
    extensions: [gfm()],
    htmlExtensions: [gfmHtml()],
  });

  // A lone image in a paragraph becomes a captioned figure — the alt text is
  // already written as a caption in the markdown.
  html = html.replace(
    /<p>(<img src="[^"]+" alt="([^"]*)"\s*\/?>)<\/p>/g,
    (_m, img, alt) => `<figure>${img}<figcaption>${alt}</figcaption></figure>`,
  );

  // Split "## 3. Your morning" into an eyebrow number plus a title, and give
  // every heading an anchor for the contents rail.
  const chapters = [];
  html = html.replace(/<h2>([^<]+)<\/h2>/g, (_m, text) => {
    const match = text.match(/^(\d+)\.\s+(.*)$/);
    const title = match ? match[2] : text;
    const id = slug(title);
    chapters.push({ n: match ? match[1] : null, title, id });
    const eyebrow = match ? `<span class="n">Chapter ${match[1]}</span>` : "";
    return `<h2 id="${id}">${eyebrow}${escapeHtml(title)}</h2>`;
  });

  html = html.replace(/<table>/g, '<div class="table-wrap wide"><table>').replace(/<\/table>/g, "</table></div>");

  const { html: inlined, misses, bytes } = await inlineImages(html);

  const toc = chapters
    .map(
      (c) =>
        `<li><a href="#${c.id}">${c.n ? `<span class="n">${c.n}</span>` : '<span class="n">·</span>'}<span>${escapeHtml(c.title)}</span></a></li>`,
    )
    .join("\n        ");

  const page = `<title>${TITLE}</title>
<style>${CSS}</style>
<div class="layout">
  <nav class="toc" aria-label="Contents">
    <div class="inner">
      <h2>Contents</h2>
      <ol>
        ${toc}
      </ol>
    </div>
  </nav>
  <main>
${inlined}
  </main>
</div>
`;

  await writeFile(OUT, page);
  const kb = (Buffer.byteLength(page) / 1024 / 1024).toFixed(2);
  console.log(`${OUT}`);
  console.log(`  ${chapters.length} sections · ${(bytes / 1024 / 1024).toFixed(2)} MB of images · ${kb} MB page`);
  if (misses.length) console.log(`  missing images: ${misses.join(", ")}`);
}

await main();
