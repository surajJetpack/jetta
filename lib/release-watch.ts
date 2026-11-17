/**
 * The release watcher: when the GetSign team ships to production, read what
 * shipped and tell the people who are waiting on it.
 *
 * A production release is a pull request merged into `main` from `dev` or
 * `qa` ("Prod Release Nov 9"). Its body is empty; the fixes are its commits,
 * "Merge pull request #224 from …/fix/…", and each number is a pull request
 * with a plain-language title. A hotfix merged straight into `main` is a
 * release of one. For every customer-visible fix Jetta does three things:
 *
 *   1. If it looks like the fix for an open dev item, she asks the Developer
 *      on that item whether it is. The developer answers by changing Dev
 *      Status, and the dev bridge (lib/dev-bridge.ts) tells the customer.
 *      Jetta never tells a customer a fix shipped on her own guess.
 *   2. Published KB articles about the changed area get a "Release changed"
 *      notice in the review queue, the same to-do the reference sync files
 *      (lib/getsign-reference.ts). The article is never edited.
 *   3. One "what shipped" note goes to Slack.
 *
 * JETTA_RELEASE_WATCH: off / shadow (work it all out, log release.*_shadow,
 * write nothing) / on. Needs JETTA_GETSIGN_REFERENCE_TOKEN with Pull requests
 * read on the four repositories; without it the watcher does nothing.
 *
 * Nothing is retried blindly: each comment, notice and note has its own
 * "done" marker, and the per-repository cursor only moves when a run finished
 * without an error. A run that failed half way is repeated next hour and
 * skips what it already did.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { config } from "./config";
import type { DevItem } from "./dev-board";
import { listDevItems } from "./dev-board-sync";
import { itemTickets } from "./dev-item-links";
import { logOpsEvent } from "./events";
import { GITHUB_OWNER, githubGet, githubReady } from "./github";
import { createArticle, getArticle, searchPublishedKb, updateArticle } from "./kb-store";
import { kvDel, kvGet, kvSet, kvSetNx, rememberJettaPost } from "./kv";
import { getModel, llmKeyPresent } from "./llm";
import { log } from "./logger";
import * as monday from "./tools/monday";
import { devItemInFlight, matchDevItem, type DevItemMatch } from "./tools/monday";
import { notifyRelease } from "./tools/slack";
import { queryVector, vectorEnabled } from "./vector";

// ── What is watched ────────────────────────────────────────────────

/** The repositories that make up the GetSign app customers use on monday. */
export const RELEASE_REPOS = ["getsign-board-view", "getsign-backend", "getsign-application", "getsign-item-view"] as const;
const PROD_BRANCH = "main";
/** Long-lived branches. A pull request FROM one of these carries other people's work; it is not a fix. */
const TRUNK = /^(main|master|dev|develop|qa|staging)$/i;

const ACTOR = "release-watch";
const DAY = 24 * 3600;
/** Comments per run. A release that matches more than this is a matcher gone wrong, not a busy week. */
const MAX_COMMENTS_PER_RUN = 10;
/** Above this the closest published article is taken to be about the fix (same bar as lib/dev-board-mine.ts). */
const KB_VECTOR = 0.8;
const KB_KEYWORD = 9;

export interface PullRef {
  repo: string;
  number: number;
  title: string;
  body: string;
  /** Branch it came from. */
  head: string;
  /** Branch it was merged into. */
  base: string;
  mergedAt: string | null;
  url: string;
}

/** Everything the watcher reads from GitHub, so a test can stand in for it. */
export interface GithubReader {
  /** Pull requests merged into the production branch after `sinceIso`. */
  mergedInto(repo: string, sinceIso: string): Promise<PullRef[]>;
  /** First line of each commit in a pull request. */
  commitHeadlines(repo: string, number: number): Promise<string[]>;
  pull(repo: string, number: number): Promise<PullRef | null>;
}

interface RawPull {
  number: number;
  title: string;
  body: string | null;
  merged_at: string | null;
  html_url: string;
  head: { ref: string };
  base: { ref: string };
}

const toPull = (repo: string, p: RawPull): PullRef => ({
  repo,
  number: p.number,
  title: p.title,
  body: p.body ?? "",
  head: p.head.ref,
  base: p.base.ref,
  mergedAt: p.merged_at,
  url: p.html_url,
});

const liveGithub: GithubReader = {
  async mergedInto(repo, sinceIso) {
    const rows = await githubGet<RawPull[]>(
      `/repos/${GITHUB_OWNER}/${repo}/pulls?state=closed&base=${PROD_BRANCH}&sort=updated&direction=desc&per_page=50`,
    );
    return rows.filter((p) => p.merged_at && p.merged_at > sinceIso).map((p) => toPull(repo, p));
  },
  async commitHeadlines(repo, number) {
    const out: string[] = [];
    // GitHub lists at most 250 commits for a pull request.
    for (let page = 1; page <= 3; page++) {
      const rows = await githubGet<{ commit: { message: string } }[]>(
        `/repos/${GITHUB_OWNER}/${repo}/pulls/${number}/commits?per_page=100&page=${page}`,
      );
      out.push(...rows.map((c) => c.commit.message.split("\n")[0]));
      if (rows.length < 100) break;
    }
    return out;
  },
  async pull(repo, number) {
    try {
      return toPull(repo, await githubGet<RawPull>(`/repos/${GITHUB_OWNER}/${repo}/pulls/${number}`));
    } catch {
      // "#123" in a commit message can be an issue, or a number from another repository.
      return null;
    }
  },
};

// ── Reading a release (pure) ───────────────────────────────────────

/** A merge into production: a bundle from dev/qa, or one hotfix. Anything else is not a release. */
export function releaseKind(pr: PullRef): "release" | "hotfix" | null {
  if (pr.base !== PROD_BRANCH || !pr.mergedAt) return null;
  return TRUNK.test(pr.head) ? "release" : "hotfix";
}

/** Pull request numbers named in a release's commits: merge commits and squash commits. */
export function fixNumbers(headlines: string[]): number[] {
  const out = new Set<number>();
  for (const h of headlines) {
    const m = h.match(/^Merge pull request #(\d+)\b/) ?? h.match(/\(#(\d+)\)\s*$/);
    if (m) out.add(Number(m[1]));
  }
  return [...out];
}

/** A back-merge or a promotion (dev → qa): it moves fixes along, it is not one. */
export function isCarrier(pr: PullRef): boolean {
  // The second half catches a merge done through a side branch to settle a
  // conflict ("Merge Conflict QA to Dev"), whose head is not a trunk.
  return TRUNK.test(pr.head) || /^(back\s*merge|merge)\b.*\b(dev|qa|main|master|staging)\b/i.test(pr.title);
}

/** monday item ids a developer linked in a pull request. */
export function mondayItemIds(text: string): string[] {
  return [...new Set([...text.matchAll(/monday\.com\/boards\/\d+(?:\/views\/\d+)?\/pulses\/(\d+)/g)].map((m) => m[1]))];
}

const PREFIX = /^(fix|feat|feature|hotfix|bugfix|chore|ci|build|test|refactor|docs|revert|perf|style)(\([^)]*\))?!?:\s*/i;
const INTERNAL = /^(chore|ci|build|test|refactor|docs|style)$/i;

/** "fix(board): show Cancelled" → "show Cancelled". */
export function plainTitle(title: string): string {
  const t = title.replace(PREFIX, "").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** One change as a customer would count it: the same branch across repositories is one fix. */
export interface Fix {
  /** The branch name: what ties the board-view half to the backend half. */
  key: string;
  title: string;
  body: string;
  prs: PullRef[];
  /** monday items the developers linked. Usually none. */
  itemIds: string[];
}

export function groupFixes(prs: PullRef[]): Fix[] {
  const by = new Map<string, PullRef[]>();
  for (const pr of prs) {
    const key = pr.head.toLowerCase();
    by.set(key, [...(by.get(key) ?? []), pr]);
  }
  return [...by.entries()].map(([key, group]) => {
    const body = group.map((p) => p.body.trim()).filter(Boolean).join("\n\n");
    return { key, title: group[0].title, body, prs: group, itemIds: mondayItemIds(body) };
  });
}

// ── Which fixes a customer would notice ────────────────────────────

export interface Label {
  customerVisible: boolean;
  /** One plain sentence for a support person. */
  summary: string;
}
export type LabelledFix = Fix & Label;
export type Labeller = (fixes: Fix[]) => Promise<Label[]>;

/** Without a model: the conventional-commit type decides. Used as the fallback, fix by fix. */
export function heuristicLabel(fix: Fix): Label {
  const m = fix.title.match(PREFIX);
  const type = m?.[1] ?? fix.key.split("/")[0];
  // "fix(build): …" mends the pipeline, not the app.
  const scope = (m?.[2] ?? "").replace(/[()]/g, "");
  return { customerVisible: !INTERNAL.test(type) && !/^(build|ci|deps|test|tests|infra|docker)$/i.test(scope), summary: plainTitle(fix.title) };
}

const LabelSchema = z.object({
  fixes: z.array(
    z.object({
      n: z.number().describe("The change's number, as given."),
      customerVisible: z.boolean().describe("True when a customer using the app could notice the difference."),
      summary: z.string().describe("One plain sentence on what changed for the customer. No code, file or branch names."),
    }),
  ),
});

const LABEL_SYSTEM = `You read the changes in a production release of GetSign, an e-signature app inside monday.com, for the support team.

For each change decide whether a customer using the app could notice it, and say what changed in one plain sentence.

- Customer-visible: a bug they could hit is fixed, a screen, label, option or behaviour changed, something new is available.
- Not customer-visible: build, CI, tests, refactors, logging, internal tooling, back-office jobs, dependency bumps.
- Use only the title and description given. Do not guess at causes or promise anything.
- No code, file, branch or function names in the sentence.
- Return every change exactly once, by its number.`;

const modelLabeller: Labeller = async (fixes) => {
  const prompt = fixes
    .map((f, i) => `${i + 1}. ${f.title}\n   repositories: ${[...new Set(f.prs.map((p) => p.repo))].join(", ")}\n   ${f.body.slice(0, 600).replace(/\n+/g, " ") || "(no description)"}`)
    .join("\n\n");
  const { object } = await generateObject({ model: getModel("light"), schema: LabelSchema, system: LABEL_SYSTEM, prompt });
  const by = new Map(object.fixes.map((x) => [x.n, x]));
  return fixes.map((f, i) => {
    const x = by.get(i + 1);
    return x && x.summary.trim() ? { customerVisible: x.customerVisible, summary: x.summary.trim() } : heuristicLabel(f);
  });
};

// ── Which dev item a fix resolves ──────────────────────────────────

/** An open dev item, as much of it as matching needs. */
export interface Candidate {
  id: string;
  name: string;
  url: string;
  group: string;
  status: string | null;
  developers: string[];
  /** Its comments, for the keyword score and the model. */
  text: string;
  /** A Freshdesk ticket is linked: a customer is waiting on this item. */
  hasTicket: boolean;
}

export function candidateOf(item: DevItem, linked: boolean): Candidate {
  const text = item.posts.map((p) => p.text).join("\n");
  return {
    id: item.id,
    name: item.name,
    url: item.url,
    group: item.group,
    status: item.status,
    developers: item.developers,
    text: text.slice(0, 4000),
    hasTicket: linked || /\/tickets\/\d+/.test(text),
  };
}

/** Every in-flight item on the GetSign board, from the hourly copy (lib/dev-board-sync.ts). */
async function loadCandidates(): Promise<Candidate[]> {
  const [items, links] = await Promise.all([listDevItems(), itemTickets()]);
  return items.filter((i) => i.board === "getsign" && devItemInFlight(i)).map((i) => candidateOf(i, links.has(i.id)));
}

export interface Pick {
  /** A shortlisted item's id, or null: none of them is this fix. */
  itemId: string | null;
  confidence: "high" | "medium" | "low";
  reason: string;
}
export type Picker = (fix: LabelledFix, shortlist: Candidate[]) => Promise<Pick>;

/** Everything known about one fix-to-item match: what `shouldSuggest` decides on. */
export interface FixMatch {
  itemId: string;
  itemName: string;
  itemUrl: string;
  /** "linked": the developer put the item in the pull request. "model": a model picked it. "keyword": word overlap alone. */
  how: "linked" | "model" | "keyword";
  /** How sure the picker was. A linked item is always "high". */
  confidence: "high" | "medium" | "low";
  /** The word-overlap score (lib/tools/monday.ts matchDevItem), or null for a linked item that shares no words. */
  keyword: DevItemMatch | null;
  /** Why, in a sentence. Shown to the developer. */
  reason: string;
  /** A customer is waiting on the item. */
  hasTicket: boolean;
  itemStatus: string | null;
  itemGroup: string;
}

const symptomOf = (fix: LabelledFix) => `${fix.summary} ${plainTitle(fix.title)}`;

/** The few open items whose words overlap the fix enough to be worth a look, best first. */
export function shortlist(fix: LabelledFix, candidates: Candidate[], n = 8): { item: Candidate; keyword: DevItemMatch }[] {
  const symptom = symptomOf(fix);
  return candidates
    .map((item) => ({ item, keyword: matchDevItem(symptom, { title: item.name, body: item.text, group: item.group }) }))
    .filter((x): x is { item: Candidate; keyword: DevItemMatch } => x.keyword !== null)
    .sort((a, b) => b.keyword.score - a.keyword.score)
    .slice(0, n);
}

const PickSchema = z.object({
  itemId: z.string().describe('The id of the item this change fixes, or "none".'),
  confidence: z.enum(["high", "medium", "low"]),
  reason: z.string().describe("One sentence: what the change and the item have in common, or why none fits."),
});

const PICK_SYSTEM = `A change has shipped to production in GetSign, an e-signature app inside monday.com. Below are open items from the developers' bug board. Decide whether the change is the fix for one of them.

- Pick an item only when the change addresses the specific problem the item describes: the same screen or feature AND the same symptom.
- The same area is not enough. Two different bugs in the same screen are different bugs.
- "high": the item's symptom is exactly what the change says it fixes. "medium": very likely the same, some detail unconfirmed. "low": a guess.
- If none fits, answer "none". That is the usual answer.`;

const modelPicker: Picker = async (fix, items) => {
  const prompt = [
    `THE CHANGE\n${plainTitle(fix.title)}\n${fix.summary}\n${fix.body.slice(0, 800)}`,
    "OPEN ITEMS",
    ...items.map((c) => `id ${c.id}: ${c.name}\n${c.text.slice(0, 500).replace(/\n+/g, " ")}`),
  ].join("\n\n");
  const { object } = await generateObject({ model: getModel("standard"), schema: PickSchema, system: PICK_SYSTEM, prompt });
  const id = object.itemId.replace(/\D/g, "");
  return { itemId: id || null, confidence: object.confidence, reason: object.reason.trim() };
};

/** Decide which open item, if any, a fix resolves. Null: none worth mentioning. */
export async function matchFix(fix: LabelledFix, candidates: Candidate[], pick: Picker | null): Promise<FixMatch | null> {
  const build = (item: Candidate, rest: Pick_<FixMatch, "how" | "confidence" | "keyword" | "reason">): FixMatch => ({
    itemId: item.id,
    itemName: item.name,
    itemUrl: item.url,
    hasTicket: item.hasTicket,
    itemStatus: item.status,
    itemGroup: item.group,
    ...rest,
  });

  // The developer said which item it is. Nothing to work out; and if that
  // item is no longer open, there is nobody to ask.
  if (fix.itemIds.length) {
    const item = candidates.find((c) => fix.itemIds.includes(c.id));
    if (!item) return null;
    const keyword = matchDevItem(symptomOf(fix), { title: item.name, body: item.text, group: item.group });
    return build(item, { how: "linked", confidence: "high", keyword, reason: "The pull request links this item." });
  }

  const short = shortlist(fix, candidates);
  if (!short.length) return null;
  if (!pick) {
    // No model: the best word overlap, and never better than "medium".
    const top = short[0];
    return build(top.item, {
      how: "keyword",
      confidence: top.keyword.confidence === "strong" ? "medium" : "low",
      keyword: top.keyword,
      reason: `Shares ${top.keyword.shared} distinctive words with the fix.`,
    });
  }
  const picked = await pick(fix, short.map((s) => s.item));
  const hit = short.find((s) => s.item.id === picked.itemId);
  if (!hit) return null;
  return build(hit.item, { how: "model", confidence: picked.confidence, keyword: hit.keyword, reason: picked.reason });
}
type Pick_<T, K extends keyof T> = { [P in K]: T[P] };

/**
 * Is this match sure enough to interrupt a developer with a comment?
 *
 * The judgment call of the whole feature. Too strict, and customers go on
 * waiting for someone to remember to change a status. Too loose, and
 * developers learn that Jetta's comments can be ignored, which costs every
 * other comment she posts on the board.
 */
export function shouldSuggest(m: FixMatch): boolean {
  // The developer named the item. Nothing is being guessed.
  if (m.how === "linked") return true;
  // Word overlap alone finds the right screen far more often than the right
  // bug; it is a shortlist, not a verdict.
  if (m.how !== "model") return false;
  if (m.confidence === "high") return true;
  // "Very likely" is worth a developer's few seconds only when a customer is
  // waiting on the answer. Otherwise the item will be closed in its own time.
  return m.confidence === "medium" && m.hasTicket;
}

// ── What Jetta writes ──────────────────────────────────────────────

/** "9 Nov", from the merge time. */
export function releaseLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

const prList = (fix: Fix) => fix.prs.map((p) => `${p.repo} #${p.number}: ${p.url}`).join(", ");

export function commentText(fix: LabelledFix, match: FixMatch, shipped: string): string {
  return [
    `The production release of ${shipped} includes "${plainTitle(fix.title)}" (${prList(fix)}).`,
    `It looks like the fix for this item. ${match.reason}`,
    match.hasTicket
      ? 'If it is, please set Dev Status to "Deployed to Prod" and I will let the customer know. If it is not, no action is needed.'
      : 'If it is, please set Dev Status to "Deployed to Prod". If it is not, no action is needed.',
  ].join("\n");
}

const noticeIdFor = (articleId: string) => `${articleId}--release-change`;
const noticeLine = (fix: LabelledFix, shipped: string) =>
  `- **${shipped}**: ${fix.summary} (${fix.prs.map((p) => `[${p.repo} #${p.number}](${p.url})`).join(", ")})`;

function noticeBody(title: string, articleId: string, line: string): string {
  return [
    `**A production release changed something [${title}](/kb/article?id=${encodeURIComponent(articleId)}) may describe.**`,
    "",
    "Jetta still answers from the article as written. Read it against the change below. " +
      "If the steps, labels or rules it gives are no longer true, edit the article; then mark this handled. " +
      "The match is by topic, so the article may well be fine.",
    "",
    "### What shipped",
    "",
    line,
  ].join("\n");
}

interface ArticleHit {
  id: string;
  title: string;
  score: number;
  /** Close enough to file a notice. */
  flag: boolean;
}

/** Published GetSign articles closest to a fix, with whether each clears the bar. */
async function closeArticles(summary: string): Promise<ArticleHit[]> {
  if (!summary.trim()) return [];
  if (vectorEnabled()) {
    const hits = await queryVector(summary, 3, ["getsign"]).catch(() => []);
    // At most two notices per fix: a third "maybe" is noise in the queue.
    return hits.map((h, i) => ({ id: h.id, title: h.title, score: +h.score.toFixed(3), flag: i < 2 && h.score >= KB_VECTOR }));
  }
  // Word counting is a blunt instrument (every GetSign article says "item"
  // and "list"), so without the vector index only the single best hit counts.
  const hits = await searchPublishedKb(summary, 3, ["getsign"]).catch(() => []);
  return hits.map((h, i) => ({ id: h.id, title: h.title, score: h.score ?? 0, flag: i === 0 && (h.score ?? 0) >= KB_KEYWORD }));
}

/** File or extend the review-queue notice for one article. True when something was written. */
async function fileNotice(articleId: string, fix: LabelledFix, shipped: string): Promise<boolean> {
  const article = await getArticle(articleId);
  // A notice is not an article, and only what Jetta answers from can be out of date.
  if (!article || article.meta?.revises || article.state !== "published") return false;
  const id = noticeIdFor(articleId);
  const line = noticeLine(fix, shipped);
  const open = await getArticle(id);
  if (open) {
    if (fix.prs.some((p) => open.body.includes(p.url))) return false;
    await updateArticle(id, { body: `${open.body}\n${line}` }, ACTOR);
    return true;
  }
  await createArticle(
    {
      id,
      title: `Release changed: ${article.title}`,
      body: noticeBody(article.title, articleId, line),
      category: article.category,
      tags: ["getsign", "release-change"],
      state: "draft",
      // Not the article's own origin: the reference sync retires
      // "getsign-reference" articles it does not recognise.
      origin: "manual",
      source: ACTOR,
      product: article.product,
      createdBy: ACTOR,
      meta: { revises: articleId },
    },
    { syncVector: false, checkDuplicates: false },
  );
  return true;
}

// ── The run ────────────────────────────────────────────────────────

export interface ReleaseWatchOptions {
  /** Read and decide, write nothing, move no cursor. Works whatever the switch says. */
  dryRun?: boolean;
  /** Read releases merged after this instant instead of the stored cursor. */
  since?: string;
  mode?: "off" | "shadow" | "on";
  now?: Date;
  github?: GithubReader;
  label?: Labeller;
  /** null: match on word overlap alone. */
  pick?: Picker | null;
  candidates?: Candidate[];
  /** Post the comment on the dev item; returns the new update's id, or null when monday writes are off. */
  comment?: Commenter;
}

export type Commenter = (itemId: string, text: string) => Promise<string | null>;

/** As Jetta, @mentioning the item's Developer so monday notifies them. */
const mondayComment: Commenter = async (itemId, text) => {
  const snapshot = await monday.getDevItemSnapshot(itemId).catch(() => null);
  const posted = await monday.postJettaComment(itemId, text, { mentionUserIds: (snapshot?.developers ?? []).map((d) => d.id) });
  return posted?.id ?? null;
};

export interface FixReport {
  key: string;
  title: string;
  summary: string;
  customerVisible: boolean;
  prs: string[];
  match: FixMatch | null;
  /** `shouldSuggest`'s verdict on the match. */
  suggest: boolean;
  /** What happened on the dev item, when a comment was called for. */
  action: "commented" | "shadow" | "dry" | "writes off" | "already asked" | "over the cap" | null;
  articles: ArticleHit[];
}

export interface ReleaseWatchResult {
  mode: "off" | "shadow" | "on";
  dry: boolean;
  /** False: no token (or stub mode), nothing was read. */
  ready: boolean;
  releases: { id: string; kind: "release" | "hotfix"; title: string; mergedAt: string; url: string }[];
  fixes: FixReport[];
  commented: number;
  /** Notice ids written. */
  noticed: string[];
  noted: boolean;
  errors: string[];
}

const cursorKey = (repo: string) => `jetta:release:cursor:${repo}`;
const prSeenKey = (pr: PullRef) => `jetta:release:pr:${pr.repo}#${pr.number}`;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** GitHub's own timestamp shape (no milliseconds), so cursors and merge times compare as text. */
const stamp = (at: Date | string) => new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");

export async function runReleaseWatch(opts: ReleaseWatchOptions = {}): Promise<ReleaseWatchResult> {
  const mode = opts.mode ?? config.releaseWatch;
  const dry = !!opts.dryRun;
  const now = opts.now ?? new Date();
  const res: ReleaseWatchResult = { mode, dry, ready: false, releases: [], fixes: [], commented: 0, noticed: [], noted: false, errors: [] };
  if (mode === "off" && !dry) return res;
  const gh = opts.github ?? (githubReady() ? liveGithub : null);
  if (!gh) return res;
  res.ready = true;

  // 1. What merged into production since last time, repository by repository.
  const found: PullRef[] = [];
  const nextCursor = new Map<string, string>();
  for (const repo of RELEASE_REPOS) {
    try {
      const since = opts.since ? stamp(opts.since) : await kvGet(cursorKey(repo));
      if (!since) {
        // First run: start from now. Last month's releases are not news.
        nextCursor.set(repo, stamp(now));
        continue;
      }
      const merged = await gh.mergedInto(repo, since);
      let newest = since;
      for (const pr of merged) {
        const kind = releaseKind(pr);
        if (!kind) continue;
        res.releases.push({ id: `${repo}#${pr.number}`, kind, title: pr.title, mergedAt: pr.mergedAt!, url: pr.url });
        if (pr.mergedAt! > newest) newest = pr.mergedAt!;
        if (kind === "hotfix") {
          found.push(pr);
          continue;
        }
        for (const n of fixNumbers(await gh.commitHeadlines(repo, pr.number))) {
          const fix = await gh.pull(repo, n);
          if (fix && !isCarrier(fix)) found.push(fix);
        }
      }
      nextCursor.set(repo, newest);
    } catch (e) {
      // This repository is read again next hour; the others carry on.
      res.errors.push(`${repo}: ${errText(e)}`);
    }
  }

  // A fix is reported once, however many releases and back-merges carry it.
  const fresh: PullRef[] = [];
  const seenThisRun = new Set<string>();
  for (const pr of found) {
    const key = prSeenKey(pr);
    if (seenThisRun.has(key)) continue;
    seenThisRun.add(key);
    if (!dry && (await kvGet(key))) continue;
    fresh.push(pr);
  }
  const fixes = groupFixes(fresh);

  let acted = true;
  if (fixes.length) {
    const shipped = releaseLabel(res.releases.map((r) => r.mergedAt).sort().at(-1) ?? now.toISOString());

    // 2. Which of them a customer would notice.
    const useModel = llmKeyPresent() && !config.stubMode;
    const labeller = opts.label ?? (useModel ? modelLabeller : null);
    let labels: Label[];
    try {
      labels = labeller ? await labeller(fixes) : fixes.map(heuristicLabel);
    } catch (e) {
      log.warn("release.label_failed", { error: errText(e), source: "cron" });
      labels = fixes.map(heuristicLabel);
    }
    const labelled: LabelledFix[] = fixes.map((f, i) => ({ ...f, ...(labels[i] ?? heuristicLabel(f)) }));

    // 3. Each visible fix against the open dev items and the published articles.
    const picker = opts.pick !== undefined ? opts.pick : useModel ? modelPicker : null;
    const visible = labelled.filter((f) => f.customerVisible);
    const candidates = visible.length ? (opts.candidates ?? (await loadCandidates().catch(() => []))) : [];
    for (const fix of labelled) {
      const report: FixReport = {
        key: fix.key,
        title: fix.title,
        summary: fix.summary,
        customerVisible: fix.customerVisible,
        prs: fix.prs.map((p) => `${p.repo}#${p.number}`),
        match: null,
        suggest: false,
        action: null,
        articles: [],
      };
      res.fixes.push(report);
      if (!fix.customerVisible) continue;
      try {
        report.match = await matchFix(fix, candidates, picker);
        report.suggest = !!report.match && shouldSuggest(report.match);
        report.articles = await closeArticles(fix.summary);
        if (report.match && report.suggest) {
          report.action = await suggest(fix, report.match, shipped, mode, dry, res, opts.comment ?? mondayComment);
        }
        for (const a of report.articles.filter((x) => x.flag)) {
          if (dry) continue;
          if (mode === "shadow") {
            await logOpsEvent({ level: "info", event: "release.kb_shadow", source: "cron", data: { fix: fix.key, articleId: a.id, title: a.title, score: a.score } });
          } else if (await fileNotice(a.id, fix, shipped)) {
            res.noticed.push(noticeIdFor(a.id));
          }
        }
      } catch (e) {
        acted = false;
        res.errors.push(`${fix.key}: ${errText(e)}`);
      }
    }

    // 4. One note for the support team.
    if (visible.length && !dry) {
      try {
        res.noted = await note(res, shipped, mode);
      } catch (e) {
        acted = false;
        res.errors.push(`note: ${errText(e)}`);
      }
    }
  }

  // 5. Only a clean run moves on. A failed one is repeated, and the markers
  //    on each comment, notice and note keep it from doing anything twice.
  if (!dry && acted) {
    for (const pr of fresh) await kvSet(prSeenKey(pr), "1", 180 * DAY);
    for (const [repo, at] of nextCursor) await kvSet(cursorKey(repo), at, 365 * DAY);
  }
  if (res.releases.length || res.errors.length) {
    log[res.errors.length ? "warn" : "info"]("cron.release_watch", {
      mode,
      dry,
      releases: res.releases.map((r) => r.id),
      fixes: res.fixes.length,
      visible: res.fixes.filter((f) => f.customerVisible).length,
      commented: res.commented,
      noticed: res.noticed.length,
      errors: res.errors,
      source: "cron",
    });
  }
  return res;
}

/** Ask the developer on the item. Returns what happened. */
async function suggest(
  fix: LabelledFix,
  match: FixMatch,
  shipped: string,
  mode: "off" | "shadow" | "on",
  dry: boolean,
  res: ReleaseWatchResult,
  comment: Commenter,
): Promise<FixReport["action"]> {
  const text = commentText(fix, match, shipped);
  if (dry) return "dry";
  if (mode !== "on") {
    await logOpsEvent({ level: "info", event: "release.suggest_shadow", source: "cron", data: { fix: fix.key, itemId: match.itemId, item: match.itemName, how: match.how, confidence: match.confidence, text } });
    return "shadow";
  }
  if (res.commented >= MAX_COMMENTS_PER_RUN) return "over the cap";
  // One ask per item per fix, for good: a re-run, or the same fix riding a later release, must not ask twice.
  const asked = `jetta:release:asked:${match.itemId}:${fix.key}`;
  if (!(await kvSetNx(asked, "1", 180 * DAY))) return "already asked";
  try {
    const postedId = await comment(match.itemId, text);
    if (!postedId) {
      await kvDel(asked);
      return "writes off";
    }
    // So the dev bridge does not answer Jetta's own comment.
    await rememberJettaPost(postedId);
    res.commented++;
    await logOpsEvent({ level: "info", event: "release.suggest", source: "cron", data: { fix: fix.key, itemId: match.itemId, how: match.how, confidence: match.confidence } });
    return "commented";
  } catch (e) {
    await kvDel(asked);
    throw e;
  }
}

/** The "what shipped" note. True when it was posted. */
async function note(res: ReleaseWatchResult, shipped: string, mode: "off" | "shadow" | "on"): Promise<boolean> {
  const visible = res.fixes.filter((f) => f.customerVisible);
  const internal = res.fixes.length - visible.length;
  const headline = `:rocket: *GetSign shipped to production, ${shipped}* — ${visible.length} change${visible.length === 1 ? "" : "s"} customers can notice`;
  const details = visible.map((f) => {
    const asked = f.action === "commented" && f.match ? ` → asked on <${f.match.itemUrl}|${f.match.itemName.slice(0, 60)}>` : "";
    const kb = f.articles.filter((a) => a.flag);
    return `• ${f.summary} (${f.prs.join(", ")})${asked}${kb.length ? ` · KB to check: ${kb.map((a) => a.title).join("; ")}` : ""}`;
  });
  if (internal) details.push(`_${internal} internal change${internal === 1 ? "" : "s"} not listed._`);
  if (mode !== "on") {
    await logOpsEvent({ level: "info", event: "release.note_shadow", source: "cron", data: { headline, details } });
    return false;
  }
  const marker = `jetta:release:noted:${res.releases.map((r) => r.id).sort().join(",")}`;
  if (!(await kvSetNx(marker, "1", 180 * DAY))) return false;
  try {
    await notifyRelease(headline, details);
    return true;
  } catch (e) {
    await kvDel(marker);
    throw e;
  }
}
