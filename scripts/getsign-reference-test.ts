/**
 * Offline test for the GetSign app reference (lib/getsign-reference.ts):
 * the hand-written articles match the vendored doc and name nothing internal,
 * and the sync files them as drafts without ever overwriting a person.
 *
 *   npx tsx scripts/getsign-reference-test.ts
 *
 * Run it WITHOUT --env-file: with KV credentials set it would write to a real
 * store.
 */
import assert from "node:assert/strict";

for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_VECTOR_REST_URL", "UPSTASH_VECTOR_REST_TOKEN"]) {
  if (process.env[k]) throw new Error(`${k} is set — run this test without --env-file`);
}

async function main() {
  const { sourceSections, staleArticles, leftovers, syncGetSignReference, articlesFor, fetchReference, onRetired } = await import(
    "../lib/getsign-reference"
  );
  const { GETSIGN_REFERENCE } = await import("../lib/knowledge/getsign-reference-doc");
  const { GETSIGN_REFERENCE_ARTICLES } = await import("../lib/knowledge/getsign-reference-articles");
  const store = await import("../lib/kb-store");
  const { deriveScope } = store;

  let n = 0;
  const check = (name: string, ok: unknown) => {
    assert.ok(ok, name);
    n++;
  };

  // ── The articles against the doc ──
  const stale = staleArticles();
  check(
    `articles match the vendored reference${stale.length ? `: reread and update ${stale.map((s) => `${s.id} ← "${s.section}" (now ${s.actual ?? "gone"})`).join("; ")}` : ""}`,
    stale.length === 0,
  );
  const covered = new Set(GETSIGN_REFERENCE_ARTICLES.flatMap((a) => a.from.map((f) => f.section)));
  const uncovered = sourceSections(GETSIGN_REFERENCE.markdown)
    .map((s) => s.section)
    .filter((s) => !covered.has(s) && !/file index/i.test(s));
  check(`every customer-facing section has an article (missing: ${uncovered.join(", ") || "none"})`, uncovered.length === 0);
  for (const a of GETSIGN_REFERENCE_ARTICLES) {
    const bad = leftovers(`${a.title}\n${a.body}`);
    check(`${a.id} names nothing internal (found: ${bad.join(" ") || "none"})`, bad.length === 0);
    check(`${a.id} has a body worth an article`, a.body.length > 400);
  }
  check("ids are unique", new Set(GETSIGN_REFERENCE_ARTICLES.map((a) => a.id)).size === GETSIGN_REFERENCE_ARTICLES.length);

  // The check itself: it must catch what the doc is full of.
  for (const internal of ["`useBoardId`", "src/routes.tsx", "envelopeName", "settingsForm.ts", "go to /workflows/new now"]) {
    check(`leftovers catches ${internal}`, leftovers(`Open ${internal} please`).length > 0);
  }
  check("leftovers lets plain prose through", leftovers("Settings → Payments, PDF/DOCX and/or email. Items/subitems.").length === 0);
  check("a renumbered heading is the same section", sourceSections("## 4. Account settings (`/settings`)\n\ntext")[0].section === "Account settings");
  check(
    "a changed section is reported against its article",
    staleArticles(GETSIGN_REFERENCE.markdown.replace("Time zone", "Timezone"))
      .map((s) => s.id)
      .includes("getsign-ref-account-settings"),
  );
  check("reference articles are GetSign's", deriveScope("getsign-reference", "getsign-reference") === "getsign");

  // ── The sync ──
  const A = (id: string, body: string) => ({ id, title: `T ${id}`, keywords: ["k"], from: [], body });
  let arts = [A("ref-a", "First article body."), A("ref-b", "Second article body.")];
  const run = () => syncGetSignReference({ articles: arts });

  let r = await run();
  check("first run creates every article", r.created === 2 && r.updated === 0);
  const a1 = await store.getArticle("ref-a");
  check("as a draft", a1?.state === "draft");
  check("scoped to GetSign, with no link", a1?.product === "getsign" && a1?.url === "" && a1?.source === "getsign-reference");
  check("nothing is searchable yet", (await store.searchPublishedKb("article body", 5, [])).length === 0);

  r = await run();
  check("a second run changes nothing", r.created === 0 && r.updated === 0 && r.unchanged === 2);

  arts = [A("ref-a", "First article body, corrected."), arts[1]];
  r = await run();
  check("an untouched draft follows the file", r.updated === 1 && (await store.getArticle("ref-a"))?.body.includes("corrected"));

  // A person rejects one draft: it stays out until the article changes.
  await store.deleteArticle("ref-b", "priya");
  r = await run();
  check("a rejected draft is not filed again", r.rejected === 1 && !(await store.getArticle("ref-b")));
  arts = [arts[0], A("ref-b", "Second article body, rewritten after the reference changed.")];
  r = await run();
  check("it comes back when the article changes", r.created === 1 && Boolean(await store.getArticle("ref-b")));

  // A person edits and publishes one: never overwritten, a notice instead.
  await store.updateArticle("ref-a", { body: "Priya's wording of the first article." }, "priya");
  await store.transitionState("ref-a", "published", "priya");
  r = await run();
  check("a person's edit alone raises nothing", r.noticed.length === 0);
  arts = [A("ref-a", "First article body, corrected. And a whole new paragraph about a new tab that was added to the settings page this week."), arts[1]];
  r = await run();
  const kept = await store.getArticle("ref-a");
  check("a person's article is never overwritten", kept?.body === "Priya's wording of the first article." && kept?.state === "published");
  const notice = await store.getArticle("ref-a--site-change");
  check("the change is filed as a notice", r.noticed.includes("ref-a") && notice?.state === "draft" && notice?.meta?.revises === "ref-a");
  check("the notice shows what is new", notice?.body.includes("new tab"));
  await assert.rejects(() => store.transitionState("ref-a--site-change", "published", "priya"));
  n++;
  r = await run();
  check("the notice is not filed twice", r.noticed.length === 0 && r.unchanged === 2);
  await store.deleteArticle("ref-a--site-change", "priya");
  r = await run();
  check("a handled notice stays handled", r.noticed.length === 0 && !(await store.getArticle("ref-a--site-change")));

  // An entry removed from the file: an untouched draft goes, a person's article gets a notice.
  arts = [arts[0]];
  r = await run();
  check("an untouched draft whose entry is gone is removed", r.retired[0]?.action === "remove" && !(await store.getArticle("ref-b")));
  arts = [];
  r = await run();
  check(
    "a published article whose entry is gone gets a notice and stays",
    r.retired[0]?.action === "notice" &&
      (await store.getArticle("ref-a"))?.state === "published" &&
      (await store.getArticle("ref-a--site-change"))?.meta?.revises === "ref-a",
  );
  check("the policy never removes what a person approved", onRetired({ state: "published" } as never, true) === "notice");
  check(
    "dry run writes nothing",
    (await syncGetSignReference({ articles: [A("ref-z", "Zed body.")], dryRun: true })).created === 1 && !(await store.getArticle("ref-z")),
  );

  // ── The reference changes under the articles ──
  check("no token, no network: the shipped copy is used", (await fetchReference()) === null);
  const doc = (settings: string, extra = "") =>
    `# Ref\n\n## 1. Settings (\`/settings\`)\n\n${settings}\n\n## 2. Sending\n\nPick an item and send.\n${extra}\n## 9. File index for agent maintainers\n\nsrc/routes.tsx\n`;
  const v1 = doc("The General tab holds the sender name.");
  const h = Object.fromEntries(sourceSections(v1).map((s) => [s.section, s.hash]));
  const curated = [
    { id: "live-settings", title: "GetSign settings", keywords: ["k"], from: [{ section: "Settings", hash: h["Settings"] }], body: "Hand-written settings article." },
    { id: "live-sending", title: "GetSign sending", keywords: ["k"], from: [{ section: "Sending", hash: h["Sending"] }], body: "Hand-written sending article." },
  ];
  let calls = 0;
  let answer = (input: { sections: { section: string; text: string }[] }) => ({
    title: "GetSign settings",
    body: `Redraft ${calls}: ${input.sections.map((x) => x.text).join(" ")} ${"This sentence pads the article out to a proper length. ".repeat(5)}`,
    keywords: ["settings"],
  });
  const rewrite = async (input: Parameters<typeof answer>[0]) => {
    calls++;
    return answer(input);
  };

  let l = await articlesFor(v1, { articles: curated, rewrite });
  check("unchanged sections use the hand-written articles, with no model call", calls === 0 && l.articles.map((a) => a.body).join() === curated.map((a) => a.body).join());

  const v2 = doc("The General tab holds the sender name and the new reply-to address.");
  l = await articlesFor(v2, { articles: curated, rewrite });
  check("a changed section redrafts its article, and only that one", calls === 1 && l.rewritten.join() === "live-settings");
  check("the redraft carries the new content", l.articles[0].body.includes("reply-to") && l.articles[1].body === "Hand-written sending article.");
  const first = l.articles[0].body;
  l = await articlesFor(v2, { articles: curated, rewrite });
  check("the same reference a day later reuses the redraft", calls === 1 && l.articles[0].body === first && l.rewritten.length === 0);

  const v3 = doc("The General tab holds the sender name, the reply-to address and a signature.");
  answer = () => ({ title: "GetSign settings", body: `Set senderEmail in \`settingsForm.ts\`. ${"Padding sentence here. ".repeat(12)}`, keywords: [] });
  l = await articlesFor(v3, { articles: curated, rewrite });
  check("a redraft that names code is refused after a second try", calls === 3 && l.pending.join() === "live-settings");
  check("and the last good text is kept meanwhile", l.articles[0].body === first);
  check("with no model the change waits", (await articlesFor(v3, { articles: curated, dryRun: true })).pending.join() === "live-settings");

  answer = (input) => ({ title: "GetSign: Templates", body: `New article. ${input.sections[0].text} ${"More about templates for the reader. ".repeat(6)}`, keywords: ["templates"] });
  const v4 = doc("The General tab holds the sender name.", "\n## 3. Templates\n\nTemplates live in the gallery.\n");
  l = await articlesFor(v4, { articles: curated, rewrite });
  check("a section no article covers gets one", l.articles.some((a) => a.id === "getsign-ref-templates" && a.body.includes("gallery")));
  check("the maintainers' section never becomes an article", !l.articles.some((a) => /file-index/.test(a.id)));

  const gone = "# Ref\n\n## 2. Sending\n\nPick an item and send.\n";
  l = await articlesFor(gone, { articles: curated, rewrite });
  check("an article whose every section is gone is left out", !l.articles.some((a) => a.id === "live-settings"));

  // End to end: a changed section reaches the review queue as an updated draft.
  answer = (input) => ({
    title: "GetSign account settings",
    body: `Final redraft of ${input.sections.length} section, with the reply-to address. ${"Padding sentence for length. ".repeat(8)}`,
    keywords: ["settings"],
  });
  r = await syncGetSignReference({ markdown: v1, rewrite });
  check("the sync can run from a given reference", r.reference === "given");
  r = await syncGetSignReference({ markdown: GETSIGN_REFERENCE.markdown.replace("Time zone;", "Time zone; reply-to address;"), rewrite });
  check("a changed real section is redrafted into the queue", r.rewritten.includes("getsign-ref-account-settings"));
  check("as a draft carrying the redraft", (await store.getArticle("getsign-ref-account-settings"))?.body.includes("reply-to address"));
  check("still a draft, never published by the sync", (await store.getArticle("getsign-ref-account-settings"))?.state === "draft");

  console.log(`getsign-reference-test: ${n} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
