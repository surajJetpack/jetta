/**
 * Offline test for the KB site sync (lib/kb-sync.ts) against the in-memory
 * store and a fake WordPress site — no Redis, no vector, no network.
 *
 *   npx tsx scripts/kb-sync-test.ts
 *
 * Run it WITHOUT --env-file: with KV credentials set it would write to a real
 * store.
 */
import assert from "node:assert/strict";

for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_VECTOR_REST_URL", "UPSTASH_VECTOR_REST_TOKEN"]) {
  if (process.env[k]) throw new Error(`${k} is set — run this test without --env-file`);
}

const BASE = "https://getsign.io";
const filler = (tag: string) =>
  Array.from({ length: 40 }, (_, i) => `${tag} sentence number ${i} explains how the feature works.`).join(" ");

/** The fake site: url path → { title, html }. Tests mutate it between runs. */
const site = new Map<string, { title: string; html: string }>();
let modifiedTick = 0;

globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  if (init?.method === "HEAD") return new Response(null, { status: 200 });
  const m = url.match(/\/wp-json\/wp\/v2\/([^?]+)\?.*page=(\d+)/);
  if (!m) throw new Error(`unexpected fetch ${url}`);
  const [, type, page] = m;
  if (type !== "pages" || page !== "1") return new Response("[]", { status: 200 });
  const posts = [...site].map(([path, p]) => ({
    title: { rendered: p.title },
    link: `${BASE}${path}`,
    modified: `2026-10-${String(10 + (modifiedTick % 10)).padStart(2, "0")}T00:00:00`,
    content: { rendered: p.html },
  }));
  return new Response(JSON.stringify(posts), { status: 200 });
}) as typeof fetch;

async function main() {
  const store = await import("../lib/kb-store");
  const { SITES, syncSite, describeChange } = await import("../lib/kb-sync");
  const getsign = SITES.find((s) => s.key === "getsign")!;
  const run = () => {
    modifiedTick++; // WordPress bumps `modified` on every save — must not matter
    return syncSite(getsign);
  };

  // The in-memory store seeds the in-code GetSign corpus on first touch; get
  // that out of the way so the fixtures below are what the sync sees.
  for (const a of await store.listArticles({ state: "published", limit: 500 })) {
    await store.transitionState(a.id, "archived", "test");
  }

  // Fixtures: a curated seed, a sync-owned page, and a sync-created page a
  // person edited (then a backfill restamped updatedBy — the trap).
  const curatedText = filler("Curated");
  await store.createArticle(
    { id: "curated", title: "Signing order", url: `${BASE}/capabilities/set-signing-order/`, body: "Hand-written summary of signing order.", state: "published", origin: "seed-getsign", source: "getsign.io", createdBy: "kb-migrate" },
    { syncVector: false, checkDuplicates: false },
  );
  await store.createArticle(
    { id: "owned", title: "MCP plugin", url: `${BASE}/mcp/docs/plugin/`, body: "Not as a plugin.", state: "published", origin: "seed-getsign", source: "getsign.io", createdBy: "kb-sync" },
    { syncVector: false, checkDuplicates: false },
  );
  await store.createArticle(
    { id: "edited", title: "Board view", url: `${BASE}/getting-started/getsign-board-view/`, body: "Original crawl text.", state: "published", origin: "seed-getsign", source: "getsign.io", createdBy: "kb-sync" },
    { syncVector: false, checkDuplicates: false },
  );
  await store.updateArticle("edited", { body: "Suraj rewrote this by hand." }, "suraj");
  await store.updateArticle("edited", { product: "getsign" }, "kb-scope-backfill");

  site.set("/capabilities/set-signing-order/", { title: "Signing order", html: `<p>${curatedText}</p>` });
  site.set("/mcp/docs/plugin/", { title: "MCP plugin", html: `<p>${filler("Plugin")} GetSign is in Anthropic's plugin directory.</p>` });
  site.set("/getting-started/getsign-board-view/", { title: "Board view", html: `<p>${filler("Board")}</p>` });
  site.set("/support-chat/", { title: "Chat with Support", html: `<p>${filler("Widget")}</p>` });

  // ── Run 1: owned page updates; hand-written ones baseline silently ──
  let r = await run();
  assert.equal(r.updated, 1, "sync-owned article follows its page");
  assert.match((await store.getArticle("owned"))!.body, /plugin directory/);
  assert.equal(r.baselined, 2, "curated + human-edited articles get a baseline, no notice");
  assert.deepEqual(r.noticed, []);
  assert.equal((await store.getArticle("edited"))!.body, "Suraj rewrote this by hand.", "human edit survives a backfill restamp");
  assert.equal((await store.getArticle("curated"))!.updatedBy, "kb-migrate", "baseline writes nothing onto the article");
  assert.equal(r.created, 0, "/support-chat is denylisted");

  // ── Run 2: nothing changed but `modified` → no work at all ──
  r = await run();
  assert.equal(r.updated + r.noticed.length + r.baselined, 0, "a bumped modified date alone is not a change");

  // ── Run 3: typography-only redesign → silently absorbed ──
  site.set("/capabilities/set-signing-order/", { title: "Signing order", html: `<p>${curatedText.replace(/works\./g, "works.  ")} </p>` });
  r = await run();
  assert.deepEqual(r.noticed, [], "whitespace change is not a notice");

  // ── Run 4: a real change → notice in the review queue ──
  const changed = curatedText + " Signers can now be reordered after sending, and the sender gets an email when the order changes.";
  site.set("/capabilities/set-signing-order/", { title: "Signing order", html: `<p>${changed}</p>` });
  r = await run();
  assert.deepEqual(r.noticed, [`${BASE}/capabilities/set-signing-order/`]);
  const notice = await store.getArticle("curated--site-change");
  assert.ok(notice, "notice filed");
  assert.equal(notice.state, "draft");
  assert.equal(notice.meta?.revises, "curated");
  assert.equal(notice.url, "", "a notice never carries the page url");
  assert.match(notice.body, /reordered after sending/);
  assert.equal((await store.getArticle("curated"))!.body, "Hand-written summary of signing order.", "curated article untouched");
  await assert.rejects(store.transitionState(notice.id, "published", "test"), /not an article/, "a notice can't be published");

  // ── Run 5: same page again → no re-flag, notice not churned ──
  const v = notice.version;
  r = await run();
  assert.deepEqual(r.noticed, [], "an open notice isn't re-filed daily");
  assert.equal((await store.getArticle(notice.id))!.version, v);

  // ── Run 6: page changes again while the notice is open → notice shows the cumulative change ──
  site.set("/capabilities/set-signing-order/", { title: "Signing order", html: `<p>${changed} A third signer role called Approver was added for compliance teams this month.</p>` });
  r = await run();
  assert.equal(r.noticed.length, 1);
  const refreshed = (await store.getArticle(notice.id))!;
  assert.match(refreshed.body, /reordered after sending/, "earlier change still listed");
  assert.match(refreshed.body, /Approver/, "new change added");

  // ── Handled: reviewer deletes the notice → page becomes the baseline, no re-file ──
  await store.deleteArticle(notice.id, "suraj");
  r = await run();
  assert.deepEqual(r.noticed, [], "handled notice stays handled");
  assert.equal(await store.getArticle(notice.id), null);

  // ── Human-edited sync article: a real page change → notice, never an overwrite ──
  site.set("/getting-started/getsign-board-view/", { title: "Board view", html: `<p>${filler("Board")} The item view is retired; configure documents once per board from the Board View settings panel.</p>` });
  r = await run();
  assert.deepEqual(r.noticed, [`${BASE}/getting-started/getsign-board-view/`]);
  assert.equal((await store.getArticle("edited"))!.body, "Suraj rewrote this by hand.");

  // describeChange ignores typography
  assert.equal(describeChange("He said \"hi\" — ok", "He said “hi” — ok").words, 0);

  console.log("kb-sync-test: all assertions passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
