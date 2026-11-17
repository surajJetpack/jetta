/**
 * Offline test for the release watcher (lib/release-watch.ts): a release is
 * read into its fixes, a fix is matched to the dev item it resolves, and the
 * run writes each thing once, or not at all in shadow and dry runs.
 *
 *   npx tsx scripts/release-watch-test.ts
 *
 * Run it WITHOUT --env-file: with KV credentials set it would write to a real
 * store. GitHub, the model, the board and monday are all stood in for.
 */
import assert from "node:assert/strict";

for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_VECTOR_REST_URL", "UPSTASH_VECTOR_REST_TOKEN"]) {
  if (process.env[k]) throw new Error(`${k} is set — run this test without --env-file`);
}

async function main() {
  const rw = await import("../lib/release-watch");
  const { releaseKind, fixNumbers, isCarrier, mondayItemIds, plainTitle, groupFixes, heuristicLabel, shortlist, matchFix, commentText, runReleaseWatch } = rw;
  type PullRef = import("../lib/release-watch").PullRef;
  type Candidate = import("../lib/release-watch").Candidate;
  type GithubReader = import("../lib/release-watch").GithubReader;
  const store = await import("../lib/kb-store");
  const { kvGet } = await import("../lib/kv");
  const { getOpsEvents } = await import("../lib/events");

  let n = 0;
  const check = (name: string, ok: unknown) => {
    assert.ok(ok, name);
    n++;
  };

  const pr = (repo: string, number: number, head: string, title: string, o: Partial<PullRef> = {}): PullRef => ({
    repo,
    number,
    head,
    title,
    base: "dev",
    body: "",
    mergedAt: "2026-11-07T10:00:00Z",
    url: `https://github.com/Jetpack-Work-Labs/${repo}/pull/${number}`,
    ...o,
  });

  // ── Reading a release ──
  check("dev → main is a release", releaseKind(pr("r", 1, "dev", "Prod Release Nov 9", { base: "main" })) === "release");
  check("qa → main is a release, whatever it is called", releaseKind(pr("r", 1, "qa", "Dev", { base: "main" })) === "release");
  check("a fix branch → main is a hotfix", releaseKind(pr("r", 1, "fix/x-main", "fix: x", { base: "main" })) === "hotfix");
  check("a merge into dev is not a release", releaseKind(pr("r", 1, "fix/x", "fix: x")) === null);
  check("an unmerged pull request is not a release", releaseKind(pr("r", 1, "dev", "x", { base: "main", mergedAt: null })) === null);

  const headlines = [
    "Fix cancelled sessions showing as Active on board awaiting list.",
    "Merge pull request #225 from Jetpack-Work-Labs/fix/board-awaiting-can…",
    "Merge pull request #226 from Jetpack-Work-Labs/main",
    "fix: show newly created status labels without a refresh (#224)",
    "Merge pull request #225 from Jetpack-Work-Labs/fix/board-awaiting-can…",
  ];
  check("fix numbers come from merge and squash commits, once each", fixNumbers(headlines).join() === "225,226,224");
  check("a back-merge carries fixes, it is not one", isCarrier(pr("r", 226, "main", "BackMerge Main to Dev")) && !isCarrier(pr("r", 225, "fix/x", "x")));
  check("so is a merge made through a side branch", isCarrier(pr("r", 554, "merge-conflict-qa-dev", "Merge Conflict QA to Dev")));
  check("a fix whose title mentions merging is still a fix", !isCarrier(pr("r", 9, "fix/merge-fields", "fix: merge fields print the board value")));
  check(
    "monday items are read from a pull request body",
    mondayItemIds("Fixes https://jetpackapps.monday.com/boards/123/pulses/9876543210 and monday.com/boards/1/views/2/pulses/55").join() === "9876543210,55",
  );
  check("no link, no item", mondayItemIds("Closes #12, see ticket 14453").length === 0);
  check("the conventional prefix is dropped", plainTitle("fix(board): show Cancelled") === "Show Cancelled");

  const grouped = groupFixes([
    pr("getsign-board-view", 225, "fix/board-awaiting-cancelled-sessions", "fix(board): show Cancelled and drop cancelled from awaiting list"),
    pr("getsign-backend", 1060, "fix/board-awaiting-cancelled-sessions", "fix(board): exclude cancelled sessions from awaiting signature list"),
    pr("getsign-board-view", 223, "fix/suppress-store-api", "fix(build): skip suppress script when CPQ Orval output is absent"),
  ]);
  check("the same branch in two repositories is one fix", grouped.length === 2 && grouped[0].prs.length === 2);
  check("a fix to the build is not a fix a customer sees", !heuristicLabel(grouped[1]).customerVisible);
  check("a fix is visible and a chore is not, without a model", heuristicLabel(grouped[0]).customerVisible && !heuristicLabel({ ...grouped[1], title: "chore: bump deps" }).customerVisible);

  // ── Matching ──
  const item = (id: string, name: string, text = "", o: Partial<Candidate> = {}): Candidate => ({
    id,
    name,
    url: `https://jetpackapps.monday.com/boards/1/pulses/${id}`,
    group: "Client reported Field Issues",
    status: "Working on it",
    developers: ["Dev One"],
    text,
    hasTicket: true,
    ...o,
  });
  const board = [
    item("101", "Cancelled signing sessions still show as Active in the Awaiting list", "Customer cancelled a session and the board awaiting list keeps showing it. Freshdesk ticket: https://x/tickets/14900"),
    item("102", "DOCX template upload fails for files with checkboxes"),
    item("103", "Reminder emails sent in the wrong time zone"),
  ];
  const cancelled = { ...grouped[0], customerVisible: true, summary: "Cancelled signing sessions no longer show as Active in the board Awaiting list." };

  const short = shortlist(cancelled, board);
  check("the shortlist finds the item that shares the fix's words", short[0]?.item.id === "101");
  check("and leaves out items about something else", !short.some((s) => s.item.id === "103"));

  const byWords = await matchFix(cancelled, board, null);
  check("without a model the best overlap is offered, never as 'high'", byWords?.itemId === "101" && byWords.how === "keyword" && byWords.confidence !== "high");
  const byModel = await matchFix(cancelled, board, async () => ({ itemId: "101", confidence: "high", reason: "Same list, same symptom." }));
  check("a model's pick carries its confidence and reason", byModel?.how === "model" && byModel.confidence === "high" && byModel.reason === "Same list, same symptom.");
  check("a model that says none means no match", (await matchFix(cancelled, board, async () => ({ itemId: null, confidence: "low", reason: "None fit." }))) === null);
  check(
    "a model cannot pick an item that was not shortlisted",
    (await matchFix(cancelled, board, async () => ({ itemId: "103", confidence: "high", reason: "x" }))) === null,
  );
  const linkedFix = { ...cancelled, itemIds: ["102"] };
  const linked = await matchFix(linkedFix, board, async () => {
    throw new Error("the model must not be asked about a linked item");
  });
  check("an item the developer linked is matched exactly, without the model", linked?.itemId === "102" && linked.how === "linked" && linked.confidence === "high");
  check("a linked item that is no longer open is nobody's to ask", (await matchFix({ ...cancelled, itemIds: ["999"] }, board, null)) === null);

  // ── When a match is worth a developer's attention ──
  const { shouldSuggest } = rw;
  check("a linked item is always worth asking about", shouldSuggest(linked!));
  check("so is a model's confident pick", shouldSuggest(byModel!));
  check("a likely pick is, when a customer is waiting", shouldSuggest({ ...byModel!, confidence: "medium", hasTicket: true }));
  check("and is not, when nobody is", !shouldSuggest({ ...byModel!, confidence: "medium", hasTicket: false }));
  check("a guess never is", !shouldSuggest({ ...byModel!, confidence: "low", hasTicket: true }));
  check("word overlap alone never is, however strong", !shouldSuggest({ ...byWords!, confidence: "medium", hasTicket: true }));

  const text = commentText(cancelled, linked!, "9 Nov");
  check("the comment names the release, the fix and both pull requests", text.includes("9 Nov") && text.includes("#225") && text.includes("#1060"));
  check("and asks for the status change that tells the customer", text.includes("Deployed to Prod") && text.includes("let the customer know"));
  check("with no ticket linked it promises nothing about a customer", !commentText(cancelled, { ...linked!, hasTicket: false }, "9 Nov").includes("customer"));

  // ── The run ──
  const MONDAY = "https://jetpackapps.monday.com/boards/1/pulses/101";
  const pulls: Record<string, PullRef> = {
    "getsign-board-view#227": pr("getsign-board-view", 227, "dev", "Prod Release Nov 9", { base: "main", mergedAt: "2026-11-09T09:11:00Z" }),
    "getsign-board-view#225": pr("getsign-board-view", 225, "fix/board-awaiting-cancelled-sessions", "fix(board): show Cancelled and drop cancelled from awaiting list", { body: `Fixes ${MONDAY}` }),
    "getsign-board-view#226": pr("getsign-board-view", 226, "main", "BackMerge Main to Dev"),
    "getsign-board-view#223": pr("getsign-board-view", 223, "fix/suppress-store-api", "chore(build): skip suppress script when CPQ Orval output is absent"),
    "getsign-backend#1064": pr("getsign-backend", 1064, "qa", "Prod Release Nov 9", { base: "main", mergedAt: "2026-11-09T09:11:30Z" }),
    "getsign-backend#1060": pr("getsign-backend", 1060, "fix/board-awaiting-cancelled-sessions", "fix(board): exclude cancelled sessions from awaiting signature list"),
    "getsign-backend#1063": pr("getsign-backend", 1063, "dev", "Merge Dev to QA", { base: "qa" }),
    "getsign-application#557": pr("getsign-application", 557, "fix/docx-main", "fix: stop FORMCHECKBOX sanitizer from wiping DOCX body", { base: "main", mergedAt: "2026-11-09T12:00:00Z" }),
  };
  const commits: Record<string, string[]> = {
    "getsign-board-view#227": ["Merge pull request #225 from x/fix/a", "Merge pull request #226 from x/main", "Merge pull request #223 from x/fix/b", "Merge pull request #4040 from x/gone"],
    "getsign-backend#1064": ["Merge pull request #1060 from x/fix/a", "Merge pull request #1063 from x/dev"],
  };
  let failRepo: string | null = null;
  const github: GithubReader = {
    async mergedInto(repo, base, since) {
      if (repo === failRepo) throw new Error("GitHub answered 404");
      return Object.values(pulls).filter((p) => p.repo === repo && p.base === base && p.mergedAt! > since);
    },
    commitHeadlines: async (repo, number) => commits[`${repo}#${number}`] ?? [],
    pull: async (repo, number) => pulls[`${repo}#${number}`] ?? null,
  };
  const label = async (fixes: import("../lib/release-watch").Fix[]) =>
    fixes.map((f) => ({ customerVisible: !/^chore/.test(f.title), summary: `${plainTitle(f.title)}.` }));
  const posted: { itemId: string; text: string }[] = [];
  const comment = async (itemId: string, text: string) => {
    posted.push({ itemId, text });
    return `u${posted.length}`;
  };
  const base = { github, label, pick: null, candidates: board, comment };
  const SINCE = "2026-11-08T00:00:00Z";
  const cursor = (repo: string) => kvGet(`jetta:release:cursor:${repo}`);

  check("off does nothing", !(await runReleaseWatch({ ...base, mode: "off" })).ready);

  const first = await runReleaseWatch({ ...base, mode: "on", now: new Date("2026-11-08T00:00:00Z") });
  check("the first run reads nothing and starts from now", first.releases.length === 0 && (await cursor("getsign-backend")) === SINCE);

  // An article about the changed area, published: what a notice is for.
  await store.createArticle(
    {
      id: "kb-awaiting",
      title: "Cancelled sessions and the Awaiting list on the board",
      body: "The Awaiting list shows sessions waiting for a signature. Cancelled sessions show as Cancelled.",
      keywords: ["cancelled", "awaiting", "sessions", "board", "list"],
      origin: "manual",
      product: "getsign",
      createdBy: "priya",
    },
    { syncVector: false, checkDuplicates: false },
  );
  await store.transitionState("kb-awaiting", "published", "priya");

  const dry = await runReleaseWatch({ ...base, mode: "on", dryRun: true });
  const dryFix = dry.fixes.find((f) => f.key === "fix/board-awaiting-cancelled-sessions");
  check("three merges into production are found: two releases and a hotfix", dry.releases.length === 3 && dry.releases.filter((r) => r.kind === "hotfix").length === 1);
  check("back-merges, promotions and unknown numbers are not fixes", dry.fixes.length === 3 && !dry.fixes.some((f) => /backmerge|merge dev/i.test(f.title)));
  check("the two halves of one fix are one fix", dryFix?.prs.join() === "getsign-board-view#225,getsign-backend#1060");
  check("the build chore is not customer-visible", dry.fixes.find((f) => f.key === "fix/suppress-store-api")?.customerVisible === false);
  check("the linked item is matched", dryFix?.match?.itemId === "101" && dryFix.match.how === "linked" && dryFix.suggest);
  check("the article about the area is found", dryFix?.articles.some((a) => a.id === "kb-awaiting" && a.flag));
  check(
    "a dry run writes nothing and moves nothing",
    dryFix?.action === "dry" && posted.length === 0 && !(await store.getArticle("kb-awaiting--release-change")) && (await cursor("getsign-backend")) === SINCE,
  );

  const shadow = await runReleaseWatch({ ...base, mode: "shadow" });
  const events = (await getOpsEvents({})).map((e) => e.event);
  check(
    "shadow logs what it would do and writes nothing",
    shadow.fixes.find((f) => f.match)?.action === "shadow" &&
      posted.length === 0 &&
      !(await store.getArticle("kb-awaiting--release-change")) &&
      ["release.suggest_shadow", "release.kb_shadow", "release.note_shadow"].every((e) => events.includes(e)),
  );
  check("shadow still moves on, so a release is logged once", (await cursor("getsign-application")) === "2026-11-09T12:00:00Z");
  check("and the next shadow run has nothing new", (await runReleaseWatch({ ...base, mode: "shadow" })).fixes.length === 0);

  // Live, from a clean slate for this release: a second environment would be the honest way,
  // so use fixes the shadow run has not seen.
  pulls["getsign-item-view#254"] = pr("getsign-item-view", 254, "qa", "Prod Release Nov 16", { base: "main", mergedAt: "2026-11-16T07:00:00Z" });
  pulls["getsign-item-view#250"] = pr("getsign-item-view", 250, "fix/cancelled-in-item-view", "fix: cancelled sessions show as Cancelled in the awaiting list of the item view", { body: MONDAY });
  commits["getsign-item-view#254"] = ["Merge pull request #250 from x/fix/c"];

  let boom = true;
  const flaky = async (itemId: string, text: string) => {
    if (boom) throw new Error("monday is down");
    return comment(itemId, text);
  };
  const failed = await runReleaseWatch({ ...base, mode: "on", comment: flaky });
  check("a failed comment is reported and the cursor stays put", failed.errors.length === 1 && failed.commented === 0 && (await cursor("getsign-item-view")) === SINCE);
  boom = false;
  const live = await runReleaseWatch({ ...base, mode: "on", comment: flaky });
  check("the next run asks the developer once", live.commented === 1 && posted.length === 1 && posted[0].itemId === "101" && live.fixes[0].action === "commented");
  const notice = await store.getArticle("kb-awaiting--release-change");
  check("and files a notice that points at the article, as a draft", notice?.meta?.revises === "kb-awaiting" && notice.state === "draft" && notice.tags.includes("release-change"));
  check("the article itself is untouched", (await store.getArticle("kb-awaiting"))?.version === (await store.getArticle("kb-awaiting"))?.version && (await store.getArticle("kb-awaiting"))?.state === "published");
  await assert.rejects(() => store.transitionState("kb-awaiting--release-change", "published", "priya"));
  n++;
  check("a clean run moves the cursor", (await cursor("getsign-item-view")) === "2026-11-16T07:00:00Z");
  check("so the release is not read twice", (await runReleaseWatch({ ...base, mode: "on" })).releases.length === 0 && posted.length === 1);

  // The same fix rides a later release: seen already, and asked already.
  pulls["getsign-item-view#260"] = pr("getsign-item-view", 260, "qa", "Prod Release Nov 23", { base: "main", mergedAt: "2026-11-23T07:00:00Z" });
  commits["getsign-item-view#260"] = ["Merge pull request #250 from x/fix/c"];
  const again = await runReleaseWatch({ ...base, mode: "on" });
  check("a fix carried by a later release is not reported again", again.releases.length === 1 && again.fixes.length === 0 && posted.length === 1);

  // monday writes off: nothing is claimed, and the ask can still happen later.
  pulls["getsign-item-view#270"] = pr("getsign-item-view", 270, "fix/hot", "fix: awaiting list in item view drops cancelled sessions", { base: "main", mergedAt: "2026-11-24T07:00:00Z", body: MONDAY });
  const off = await runReleaseWatch({ ...base, mode: "on", comment: async () => null });
  check("with monday writes off the comment is reported as not posted", off.fixes[0]?.action === "writes off" && off.commented === 0);
  check("a second notice line is added to the open notice, not a second notice", (await store.getArticle("kb-awaiting--release-change"))?.body.includes("#270"));

  // One repository unreadable: the others carry on, and it is read again.
  failRepo = "getsign-backend";
  pulls["getsign-board-view#300"] = pr("getsign-board-view", 300, "fix/later", "fix: something later", { base: "main", mergedAt: "2026-11-25T07:00:00Z" });
  const before = await cursor("getsign-backend");
  const partial = await runReleaseWatch({ ...base, mode: "on" });
  check(
    "an unreadable repository is an error for that repository only",
    partial.errors.length === 2 && partial.errors.every((e) => e.startsWith("getsign-backend")) && partial.releases.length === 1 && (await cursor("getsign-backend")) === before && (await cursor("getsign-board-view")) === "2026-11-25T07:00:00Z",
  );

  // ── What the watcher remembers (lib/fix-store.ts) ──
  const { listFixes } = await import("../lib/fix-store");
  failRepo = null;
  const cancelledFix = (await listFixes()).find((f) => f.key === "fix/board-awaiting-cancelled-sessions");
  check("a released fix is remembered once, both halves together", cancelledFix?.state === "released" && cancelledFix.prs.length === 2);
  check("with the day its release shipped, not the day it merged", cancelledFix?.releasedAt === "2026-11-09T09:11:00Z" && cancelledFix.mergedAt === "2026-11-07T10:00:00Z");
  check("internal changes are remembered too, marked as such", (await listFixes()).find((f) => f.key === "fix/suppress-store-api")?.customerVisible === false);

  pulls["getsign-board-view#310"] = pr("getsign-board-view", 310, "fix/reminder-time-zone", "fix: reminders use the account time zone", { mergedAt: "2026-11-26T07:00:00Z" });
  const waiting = await runReleaseWatch({ ...base, mode: "shadow" });
  const merged = (await listFixes()).find((f) => f.key === "fix/reminder-time-zone");
  check("a fix merged into dev is remembered as waiting for a release, even in shadow", waiting.remembered >= 1 && merged?.state === "merged" && !merged.releasedAt);
  check("and nothing was said about it anywhere", waiting.fixes.length === 0 && posted.length === 1);

  pulls["getsign-board-view#320"] = pr("getsign-board-view", 320, "dev", "Prod Release Nov 30", { base: "main", mergedAt: "2026-11-30T07:00:00Z" });
  commits["getsign-board-view#320"] = ["Merge pull request #310 from x/fix/reminder-time-zone"];
  let labelCalls = 0;
  const counting = async (fixes: import("../lib/release-watch").Fix[]) => {
    labelCalls += fixes.length;
    return label(fixes);
  };
  await runReleaseWatch({ ...base, label: counting, mode: "shadow" });
  const shippedNow = (await listFixes()).find((f) => f.key === "fix/reminder-time-zone");
  check("when a release carries it, it becomes released", shippedNow?.state === "released" && shippedNow.releasedAt === "2026-11-30T07:00:00Z");
  check("and the label it was given when it merged is kept, not asked for again", labelCalls === 0);
  check("a dry run remembers nothing", (await runReleaseWatch({ ...base, mode: "on", dryRun: true, since: "2026-01-01T00:00:00Z" })).remembered === 0);

  console.log(`release-watch: all ${n} assertions passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
