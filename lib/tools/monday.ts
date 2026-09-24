/**
 * monday.com tool client — Dev board search / create (board GraphQL API,
 * board-scoped MONDAY_API_TOKEN).
 *
 * Marketplace monetization (trial extension + discounts) lives in
 * lib/tools/monday-monetization.ts — it needs app-level credentials the board
 * token can't provide, so it's a separate client.
 */
import { config } from "../config";
import type { AttachmentFile, DevBoardItem, Product } from "../types";

const GRAPHQL = "https://api.monday.com/v2";
/** File uploads go to a separate multipart endpoint, not the GraphQL one. */
const FILE_UPLOAD = "https://api.monday.com/v2/file";

/** "unknown"-product tickets fall back to the general jetpackapps board. */
export function boardIdFor(product: Product): string | undefined {
  return product === "getsign" ? config.monday.boardIds.getsign : config.monday.boardIds.jetpackapps;
}

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(GRAPHQL, {
    method: "POST",
    headers: {
      Authorization: config.monday.apiToken ?? "",
      "Content-Type": "application/json",
      "API-Version": "2024-10",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) {
    throw new Error(`monday GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  if (!json.data) throw new Error("monday GraphQL returned no data");
  return json.data;
}

function itemUrl(itemId: string, product: Product): string {
  return `${config.monday.accountUrl}/boards/${boardIdFor(product)}/pulses/${itemId}`;
}

/**
 * Attach the customer's own evidence (screenshots, screen recordings, documents)
 * to an update, so a dev opening the item sees the bug instead of only a
 * description of it.
 *
 * monday takes files over the GraphQL multipart spec at a dedicated endpoint:
 * the mutation goes in `query`, and `map` points a named file part at the $file
 * variable. `update_id` is interpolated rather than sent as a variable because
 * its declared GraphQL type has moved between API versions (Int! → ID!) — the
 * value comes from monday's own response, and is digit-checked below.
 *
 * Best-effort by design: returns the names that actually landed, and never
 * throws. A failed upload must not undo an escalation that already succeeded.
 */
async function attachFilesToUpdate(
  updateId: string | null,
  files: AttachmentFile[],
): Promise<string[]> {
  if (!updateId || !files.length) return [];
  if (!/^\d+$/.test(updateId)) {
    console.warn(`monday: unexpected update id "${updateId}", skipping ${files.length} file(s).`);
    return [];
  }

  const uploaded: string[] = [];
  for (const file of files) {
    try {
      const form = new FormData();
      form.append(
        "query",
        `mutation ($file: File!) { add_file_to_update(update_id: ${updateId}, file: $file) { id } }`,
      );
      form.append("map", JSON.stringify({ image: "variables.file" }));
      form.append("image", new Blob([file.data], { type: file.contentType }), file.name);

      const res = await fetch(FILE_UPLOAD, {
        method: "POST",
        // No Content-Type header — fetch must set the multipart boundary itself.
        headers: { Authorization: config.monday.apiToken ?? "", "API-Version": "2024-10" },
        body: form,
      });
      const json = (await res.json()) as { errors?: { message: string }[] };
      if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
      uploaded.push(file.name);
    } catch (e) {
      console.warn(`monday: upload of "${file.name}" failed, skipping:`, e);
    }
  }
  return uploaded;
}

type MondayColumnValue = {
  text: string | null;
  type: string;
  column: { title: string } | null;
};

/**
 * Which column says how far along an item is.
 *
 * Both dev boards carry FOUR status-type columns — Dev Status, Project,
 * Priority and Type — so "the first status column" resolves to "VLOOKUP" on
 * one item and "Working on it" on the next. The progress one is titled "Dev
 * Status" on both; a plain "Status" is accepted as a fallback for a board that
 * has not been renamed.
 *
 * Unmatched reads "unknown", never "open". This field was HARDCODED to "open"
 * until 2026-08-16: every search told the agent — and any colleague asking in
 * Slack — that a shipped item was still live, in the same confident sentence
 * as the facts that were true.
 */
const PROGRESS_COLUMN_TITLES = ["dev status", "status"];

/**
 * First non-empty column of `type` whose title starts with one of `titles`,
 * in the order given.
 *
 * Prefix rather than exact match because board titles carry decoration: the
 * jetpackapps board's assignee column is literally "Developer  ↗️", and an
 * exact comparison silently returns nobody for every item on that board.
 */
function pickColumn(
  columns: MondayColumnValue[] | null | undefined,
  type: string,
  titles: string[],
): string | undefined {
  for (const title of titles) {
    const hit = (columns ?? []).find(
      (c) => c.type === type && c.column?.title?.trim().toLowerCase().startsWith(title),
    );
    if (hit?.text?.trim()) return hit.text.trim();
  }
  return undefined;
}

/**
 * Words that say nothing about WHICH bug this is.
 *
 * The matcher this replaces kept every token longer than two characters and
 * called an item a match on ONE shared token, so "the", "not", "issue" and
 * "monday" all voted — and on a board where every row is a monday app bug,
 * those are true of everything. Run over the real boards, the old rule
 * returned five "matches" for "Billing: I was charged twice this month" and
 * five more for "How do I add a column to my board?".
 *
 * Deliberately NOT stripped: board, item, column, template, webhook and the
 * other domain nouns. They read as generic and are the opposite — "column
 * values not syncing" and "email not sending" are different bugs precisely
 * because of them.
 */
const STOPWORDS = new Set(
  (
    "the and for with from this that they them their was were has have had not but are you your our " +
    "its when what why how all any can cant could did does doing get gets got into just like need needs " +
    "now one only out over see some still such than then there these those too use used using very " +
    "will would after again also been being because before both each few more most other same should " +
    "under until while about which who whom where " +
    // Support vocabulary — true of nearly every row on a bug board.
    "issue issues problem problems error errors bug bugs fail fails failed failing broken break breaks " +
    "work works working help please support ticket tickets customer customers user users account accounts " +
    "app apps application monday getsign jetpack jetpackapps"
  ).split(" "),
);

/** Group titles that mean the work is finished, not in flight. */
const CLOSED_GROUP = /done|deployed|archive|shipped|released/;

/**
 * Group titles that hold wishes rather than faults. An item here can be a
 * lead ("someone asked for this"), never a confident duplicate of a customer's
 * broken workflow: "Failed to send document for signature" scores 0.86 against
 * the backlog's "As a user I would like to send document for approval", and
 * they are not the same thing at all.
 */
const FEATURE_GROUP = /feature|enhancement|backlog|coming up|idea|wish/;

/** Above this, two descriptions are the same issue. */
const STRONG_MATCH = 0.65;
/** Above this, worth a human's glance; below it, not worth surfacing at all. */
const POSSIBLE_MATCH = 0.5;
/** Fewer shared distinctive words than this is a coincidence, not a match. */
const MIN_SHARED_TERMS = 2;
/**
 * A symptom with fewer distinctive words than this can be a lead, never "the
 * same bug".
 *
 * The body is corroboration, and on a two-word symptom a single half-weight
 * body hit is a third of the whole score. Run over the live boards, exactly
 * one pair in 19,800 needed this: the symptom "VLookUp questions" scored 0.75
 * against "VLookUp Template not working" — one word in the title, the other
 * somewhere in a comment thread — which is enough to BLOCK a customer's report
 * from being filed. Two words is not enough evidence to decide that, whatever
 * it scores.
 */
const MIN_TERMS_FOR_STRONG = 3;

/**
 * Distinctive words in a piece of text: lowercased, split on non-alphanumerics,
 * three characters or more, stopwords dropped, trailing plural "s" removed so
 * "documents" and "document" count as one term.
 */
function terms(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    out.add(raw.length > 3 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw);
  }
  return out;
}

/**
 * How alike two bug descriptions are, 0 to 1 — Sørensen–Dice over distinctive
 * terms. It measures OVERLAP rather than "shares a word", so a long symptom
 * that happens to brush a short item title scores low instead of scoring a hit.
 *
 * Terms found in the item's body but not its title count half: a terse title
 * with a detailed description is a real duplicate worth catching, and the body
 * is also where a dozen unrelated words live.
 */
function similarity(q: Set<string>, title: Set<string>, body: Set<string>): number {
  if (!q.size || !title.size) return 0;
  let hits = 0;
  for (const t of q) hits += title.has(t) ? 1 : body.has(t) ? 0.5 : 0;
  return Math.min(1, (2 * hits) / (q.size + title.size));
}

/** How many of `q`'s terms appear anywhere in the item. */
function sharedTerms(q: Set<string>, title: Set<string>, body: Set<string>): number {
  let n = 0;
  for (const t of q) if (title.has(t) || body.has(t)) n++;
  return n;
}

/** What one item scored against a symptom, when it scored enough to matter. */
export interface DevItemMatch {
  confidence: "strong" | "possible";
  score: number;
  /** Distinctive words the two descriptions have in common. */
  shared: number;
}

/**
 * Score one dev item against a symptom, or return null when it is not worth
 * surfacing at all.
 *
 * Pure and exported so the thresholds can be tested without a board
 * (scripts/dev-board-match-test.ts) — the decision it encodes is "does this
 * customer's problem already have an item", and getting it wrong in either
 * direction costs: a false match buries a new report on someone else's bug, a
 * missed one duplicates work.
 */
export function matchDevItem(
  symptom: string,
  item: { title: string; body?: string; group?: string },
): DevItemMatch | null {
  const q = terms(symptom);
  if (q.size < MIN_SHARED_TERMS) return null;
  const title = terms(item.title);
  const body = terms(item.body ?? "");
  const shared = sharedTerms(q, title, body);
  const score = similarity(q, title, body);
  if (shared < MIN_SHARED_TERMS || score < POSSIBLE_MATCH) return null;
  const feature = FEATURE_GROUP.test((item.group ?? "").toLowerCase());
  const enoughToBeSure = q.size >= MIN_TERMS_FOR_STRONG;
  return {
    confidence: score >= STRONG_MATCH && !feature && enoughToBeSure ? "strong" : "possible",
    score: Number(score.toFixed(2)),
    shared,
  };
}

/**
 * How many updates to read per item.
 *
 * Deliberately generous. The busiest item on either board carries six, and a
 * live probe put `updates(limit: 20)` at the same query complexity (9348 vs
 * 9346) and the same response size as `limit: 5` — monday charges for the
 * connection, not the rows. A tight window would silently drop the ONE update
 * that matters: Jetta posts her context first, so on an item engineering has
 * since discussed, the oldest update is the one carrying the ticket link.
 */
const UPDATES_PER_ITEM = 20;

/** A board row with everything the matcher and the duplicate guard read. */
interface BoardItemRow {
  id: string;
  name: string;
  group: { title: string } | null;
  column_values: MondayColumnValue[] | null;
  updates: { text_body: string | null }[] | null;
}

/**
 * Every item on the board, with its updates, in one query.
 *
 * The updates are not a nicety. `createDevItem` writes the error description,
 * the repro steps and the Freshdesk ticket link into an UPDATE, and populates
 * columns only where the board happens to have ones whose titles match. The
 * GetSign board has no `long_text` or `text` column at all — Bug Description
 * and Account URL are mirrors — so before this, everything read here about a
 * GetSign item was its title. Both callers below were working from a third of
 * the evidence on the board that files the most items.
 *
 * The 100-item window is NOT 100 of the board. GetSign holds 1373 items and
 * Dev Tasks 967, almost all of them Done (1237 and 901). What the window
 * actually covers is every live group on both boards — every Client reported
 * Field Issue, Internal Bug and Coming Up row, and 50 of GetSign's 86 Backlog
 * rows, which are FEATURE_GROUP and can never be more than "possible" anyway.
 *
 * That holds only because monday returns the groups in board order and Done is
 * LAST on both. Reorder the groups, or grow the live ones past ~100, and this
 * silently starts reading finished work instead of current work: the search
 * goes quiet and the duplicate guard below stops seeing the item it exists to
 * find. Neither failure announces itself. If that day comes, page the
 * non-closed groups rather than raising the limit.
 */
async function fetchBoardItems(board: string | undefined): Promise<BoardItemRow[]> {
  // No board configured for this product: the query would error and be
  // swallowed anyway, so say "nothing on the board" directly.
  if (!board) return [];
  const data = await gql<{ boards: { items_page: { items: BoardItemRow[] } }[] }>(
    `query ($board: [ID!]) {
      boards(ids: $board) {
        items_page(limit: 100) {
          items {
            id
            name
            group { title }
            column_values { text type column { title } }
            updates(limit: ${UPDATES_PER_ITEM}) { text_body }
          }
        }
      }
    }`,
    { board: [board] },
  ).catch(() => null);
  return data?.boards?.[0]?.items_page?.items ?? [];
}

/**
 * Metadata lines in one of Jetta's updates — the label IS the whole value, and
 * the value says nothing about which bug this is.
 *
 * Stripping them is what makes it safe to feed updates to the matcher. Every
 * item she files carries the same header, so leaving it in would hand a free
 * half-point to EVERY item on the board for a symptom that happens to say
 * "product" or "conversation".
 */
const UPDATE_METADATA_LINE = /^\s*(product|account|freshdesk ticket|conversation|surface)\s*:/i;
/** Labels whose value is the real content, so only the label comes off. */
const UPDATE_LABEL = /^\s*(error|reproduction steps|repro steps)\s*:\s*/i;

/**
 * One of Jetta's updates reduced to the words that describe the bug: headers
 * dropped, labels unwrapped, URLs removed (a ticket link contributes "https",
 * "freshdesk" and "com" to no bug in particular).
 *
 * Exported for scripts/dev-board-match-test.ts, which pins the stripping — a
 * regression here does not fail loudly, it just quietly makes every item look
 * a little more like every symptom.
 */
export function devItemUpdateText(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => !UPDATE_METADATA_LINE.test(line))
    .map((line) => line.replace(UPDATE_LABEL, ""))
    .join("\n")
    .replace(/https?:\/\/\S+/g, " ")
    .trim();
}

/** Everything on an item that describes the problem, for the matcher. */
function itemBodyText(item: BoardItemRow): string {
  return [
    // Free-text columns only: link columns hold ticket and account URLs, whose
    // words belong to no bug in particular.
    ...(item.column_values ?? [])
      .filter((c) => c.type === "long_text" || c.type === "text")
      .map((c) => c.text ?? ""),
    ...(item.updates ?? []).map((u) => devItemUpdateText(u.text_body ?? "")),
  ].join(" ");
}

/** The Freshdesk ticket id in a ticket URL, or null when there isn't one. */
export function freshdeskTicketId(url: string): string | null {
  return /\/tickets\/(\d+)/.exec(url)?.[1] ?? null;
}

/**
 * Is this item already the one filed for that Freshdesk ticket?
 *
 * Read off the RAW update text, not the matcher's cleaned copy — the ticket
 * link is exactly what that one strips. The lookahead stops ticket 1433 from
 * matching the item filed for 14331.
 *
 * (An older `itemMentionsTicket` existed for the retired +1 flow and asked a
 * different question — "might a human have mentioned this ticket here". This
 * one asks whether WE filed for it, which is exact.)
 */
export function itemCarriesTicket(
  item: {
    column_values?: { text: string | null }[] | null;
    updates?: { text_body: string | null }[] | null;
  },
  ticketId: string,
): boolean {
  const link = new RegExp(`/tickets/${ticketId}(?![0-9])`);
  return [
    ...(item.column_values ?? []).map((c) => c.text ?? ""),
    ...(item.updates ?? []).map((u) => u.text_body ?? ""),
  ].some((text) => link.test(text));
}

/**
 * Find the dev items that might be this customer's problem, with an explicit
 * confidence on each.
 *
 * The confidence is the point. A search that hands back five loose candidates
 * and leaves the model to decide is how a customer's new bug got attached to
 * somebody else's month-old item — the model reads "returned by the search" as
 * "this is the one". Now a hit has to clear a real overlap bar AND share at
 * least two distinctive words, and what comes back says whether it is the same
 * issue ("strong") or merely worth a look ("possible"). Nothing below that
 * surfaces at all: no match is a perfectly good answer and the safe one, since
 * the alternative is filing a fresh item that a human can merge.
 */
export async function searchDevBoard(symptom: string, product: Product): Promise<DevBoardItem[]> {
  if (!config.monday.live) {
    if (/mapping|map|column/i.test(symptom)) {
      return [
        {
          id: "5566778899",
          title: "[GetSign] Mapping editor: confirm-on-close UX confusion",
          status: "Working on it",
          url: itemUrl("5566778899", "getsign"),
          assignee: "Dev (stub)",
          priority: "Medium",
          updatedAt: "2026-08-01 09:00:00 UTC",
          confidence: "strong",
          matchScore: 1,
          state: "open",
          group: "Bugs and Field Issues",
        },
      ];
    }
    return [];
  }

  // Fetch board items and score them here rather than through monday's
  // contains_text rule, which is a strict substring match on the full phrase
  // and misses near-matches ("signed document syncing" vs "...not syncing...").
  const board = boardIdFor(product);
  const items = await fetchBoardItems(board);

  const scored = items
    .map((i) => {
      const groupTitle = i.group?.title?.trim() ?? "";
      const match = matchDevItem(symptom, {
        title: i.name,
        body: itemBodyText(i),
        group: groupTitle,
      });
      return { i, groupTitle, match, closed: CLOSED_GROUP.test(groupTitle.toLowerCase()) };
    })
    .filter((r): r is typeof r & { match: DevItemMatch } => r.match !== null)
    // Same issue first, then live work over finished work, then by overlap.
    .sort(
      (a, b) =>
        Number(b.match.confidence === "strong") - Number(a.match.confidence === "strong") ||
        Number(a.closed) - Number(b.closed) ||
        b.match.score - a.match.score,
    )
    .slice(0, 3);

  return scored.map(({ i, groupTitle, match, closed }) => ({
    id: i.id,
    title: i.name,
    status: pickColumn(i.column_values, "status", PROGRESS_COLUMN_TITLES) ?? "unknown",
    url: itemUrl(i.id, product),
    // "Reporter" is a people column too, so the title is what separates them.
    assignee: pickColumn(i.column_values, "people", ["developer", "assignee", "owner"]),
    priority: pickColumn(i.column_values, "status", ["priority"]),
    updatedAt: pickColumn(i.column_values, "last_updated", ["last updated"]),
    confidence: match.confidence,
    matchScore: match.score,
    state: closed ? "closed" : "open",
    group: groupTitle || undefined,
  }));
}

/**
 * Which group a customer-reported bug belongs in, by group TITLE.
 *
 * Without this the mutation sends no `group_id` and monday drops the item in
 * the board's TOP group — which on the GetSign board is "Current tasks", a
 * group of work already in flight. Every item Jetta filed there had to be
 * dragged into "Client reported Field Issues" by hand. (The jetpackapps board
 * is unaffected: its top group is already "Bugs and Field Issues".)
 *
 * Matched by title in priority order rather than pinned to a group id in
 * config: the two boards use the SAME ids for different groups — `new_group`
 * is "Client reported Field Issues" on GetSign and "Bugs and Field Issues" on
 * Dev Tasks — so an id is only meaningful next to its board, while the titles
 * say what the group is for. A board that matches nothing (a test board) falls
 * through to monday's default, exactly as before.
 */
const FIELD_ISSUE_GROUP_TITLES = [/client reported/, /field issue/, /^bugs?\b/];

function pickGroupId(groups: { id: string; title: string }[] | undefined): string | undefined {
  for (const pattern of FIELD_ISSUE_GROUP_TITLES) {
    const hit = (groups ?? []).find((g) => pattern.test(g.title.trim().toLowerCase()));
    if (hit) return hit.id;
  }
  return undefined;
}

export interface CreateDevItemInput {
  title: string;
  product: Product;
  accountUrl: string;
  errorDescription: string;
  reproSteps: string;
  freshdeskTicketUrl: string;
  /** Customer-supplied evidence to attach to the item's update. */
  attachments?: AttachmentFile[];
}

/** A created item, plus the names of the files that actually attached. */
export type CreatedDevItem = DevBoardItem & {
  filesAttached: string[];
  /**
   * True when this ticket already had an item and the context went onto that
   * one as a comment. The caller must say so rather than report a new filing —
   * an agent told "created" for an item it did not create will describe a fresh
   * report to the team that nobody made.
   */
  deduped?: boolean;
};

/** The context block Jetta posts on an item, as an update. */
function contextBody(input: CreateDevItemInput, followUp: boolean): string {
  return [
    ...(followUp
      ? [
          `Follow-up from the SAME Freshdesk ticket — added here rather than filed as a second item.`,
          "",
        ]
      : []),
    `Product: ${input.product}`,
    `Account: ${input.accountUrl}`,
    `Freshdesk ticket: ${input.freshdeskTicketUrl}`,
    "",
    `Error: ${input.errorDescription}`,
    "",
    `Reproduction steps:\n${input.reproSteps}`,
  ].join("\n");
}

/**
 * Post an update on an item and hang the customer's files off it.
 *
 * The update is the one place on an item guaranteed to exist regardless of
 * which columns the configured board happens to have — which, on the GetSign
 * board, is none of the ones `createDevItem` looks for.
 */
async function postContextUpdate(
  itemId: string,
  body: string,
  attachments: AttachmentFile[],
): Promise<string[]> {
  const update = await gql<{ create_update: { id: string } }>(
    `mutation ($item: ID!, $body: String!) { create_update(item_id: $item, body: $body) { id } }`,
    { item: itemId, body },
  ).catch(() => null);
  return attachFilesToUpdate(update?.create_update.id ?? null, attachments);
}

export async function createDevItem(input: CreateDevItemInput): Promise<CreatedDevItem> {
  const fileCount = input.attachments?.length ?? 0;
  const files = fileCount ? ` (+${fileCount} file${fileCount === 1 ? "" : "s"})` : "";
  if (!config.monday.live) {
    const id = "9900112233";
    console.log(`[stub] create_dev_item "${input.title}"${files}`);
    return { id, title: input.title, status: "New", url: itemUrl(id, input.product), filesAttached: [] };
  }
  if (!config.monday.allowWrites) {
    const id = "9900112233";
    console.log(
      `[MONDAY_ALLOW_WRITES=false] would create_dev_item "${input.title}"${files} — no write made.`,
    );
    return { id, title: input.title, status: "New", url: itemUrl(id, input.product), filesAttached: [] };
  }

  const board = boardIdFor(input.product);

  /*
   * One item per Freshdesk ticket.
   *
   * The similarity matcher below is the wrong instrument for this question.
   * Ticket 14331 got two items 29 minutes apart because a second run scored
   * the first item at 0.62 — one notch under the 0.65 that means "the same
   * bug" — and the rule for a "possible" match is, correctly, to file anyway
   * and let a human merge. That rule is about two different CUSTOMERS who
   * might have one bug. Two runs on one ticket are not that: it is the same
   * report, and the ticket id answers it exactly, with no threshold to miss.
   *
   * Deliberately not blocked by a FINISHED item: if the same ticket comes back
   * to life weeks after its item shipped, a new item is the right outcome.
   */
  const ticketId = freshdeskTicketId(input.freshdeskTicketUrl);
  if (ticketId) {
    const existing = (await fetchBoardItems(board)).find(
      (i) =>
        itemCarriesTicket(i, ticketId) &&
        !CLOSED_GROUP.test((i.group?.title ?? "").trim().toLowerCase()),
    );
    if (existing) {
      // Whatever the customer said since is the reason there was a second run
      // at all, so it goes onto the item — unless it is already there, which
      // is what a run repeating itself looks like.
      const alreadyPosted = (existing.updates ?? []).some((u) =>
        (u.text_body ?? "").includes(input.errorDescription.trim()),
      );
      const filesAttached = alreadyPosted
        ? []
        : await postContextUpdate(existing.id, contextBody(input, true), input.attachments ?? []);
      return {
        id: existing.id,
        title: existing.name,
        status: pickColumn(existing.column_values, "status", PROGRESS_COLUMN_TITLES) ?? "unknown",
        url: itemUrl(existing.id, input.product),
        filesAttached,
        deduped: true,
      };
    }
  }

  // Discover the board's columns and groups so we can populate structured
  // fields by title and land the item in the right group, adapting to whatever
  // board is configured (test board or real bug tracker).
  const meta = await gql<{
    boards: {
      columns: { id: string; title: string; type: string }[];
      groups: { id: string; title: string }[];
    }[];
  }>(
    `query ($board: [ID!]) {
      boards(ids: $board) { columns { id title type } groups { id title } }
    }`,
    { board: [board] },
  ).catch(() => null);
  const cols = meta?.boards?.[0]?.columns ?? [];
  const find = (type: string, kw: RegExp) =>
    cols.find((c) => c.type === type && kw.test(c.title.toLowerCase()))?.id;
  const groupId = pickGroupId(meta?.boards?.[0]?.groups);

  const cv: Record<string, unknown> = {};
  const stepsCol = find("long_text", /step|repro/);
  if (stepsCol) cv[stepsCol] = input.reproSteps;
  const errCol = find("long_text", /error|actual|description/);
  if (errCol) cv[errCol] = input.errorDescription;
  const acctCol = find("link", /account/);
  if (acctCol && input.accountUrl.startsWith("http")) {
    cv[acctCol] = { url: input.accountUrl, text: "Account" };
  }
  const tixCol = find("link", /ticket|freshdesk/);
  if (tixCol && input.freshdeskTicketUrl.startsWith("http")) {
    cv[tixCol] = { url: input.freshdeskTicketUrl, text: "Freshdesk ticket" };
  }

  // `group_id` is omitted rather than sent as null when no group matched —
  // monday then applies its own default (the board's top group), which is the
  // behaviour this function had before.
  const data = await gql<{ create_item: { id: string; name: string } }>(
    `mutation ($board: ID!, $name: String!, $cv: JSON!${groupId ? ", $group: String!" : ""}) {
      create_item(
        board_id: $board
        item_name: $name
        column_values: $cv
        ${groupId ? "group_id: $group" : ""}
      ) { id name }
    }`,
    { board, name: input.title, cv: JSON.stringify(cv), ...(groupId ? { group: groupId } : {}) },
  );
  const id = data.create_item.id;

  // Also post the full context as an update — keeps product/ticket visible,
  // covers boards that lack matching columns, and is what the duplicate guard
  // above reads on the next run.
  const filesAttached = await postContextUpdate(
    id,
    contextBody(input, false),
    input.attachments ?? [],
  );

  return { id, title: input.title, status: "New", url: itemUrl(id, input.product), filesAttached };
}

/**
 * Which board each item lives on, in one query.
 *
 * A DM carries no product context, so a dev-item id mentioned in prose could
 * belong to either board — and guessing produces a confident link into the
 * wrong board, which is worse than leaving the number as text. One lookup
 * removes the guess.
 */
export async function resolveItemBoards(itemIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(itemIds)].filter(Boolean);
  if (!ids.length || !config.monday.live) return out;
  const data = await gql<{ items: { id: string; board: { id: string } | null }[] }>(
    `query ($ids: [ID!]) { items(ids: $ids) { id board { id } } }`,
    { ids },
  ).catch(() => null);
  for (const item of data?.items ?? []) {
    if (item.board?.id) out.set(item.id, item.board.id);
  }
  return out;
}

export interface DevItemUpdate {
  at: string;
  author: string;
  text: string;
  replies: { at: string; author: string; text: string }[];
}

/**
 * Read what engineering actually said on a dev item — the updates thread, with
 * replies, newest first.
 *
 * Offered to BOTH toolsets, but on different terms. These are internal
 * engineering notes ("this is a race in the webhook registration, punting to
 * next sprint"), and the ticket agent's whole job is writing to customers — so
 * there it is fenced by the rules in lib/system-prompt.ts (never quote, never
 * name an engineer, never repeat a version or sprint) and guarded by
 * scripts/dev-comment-leak-test.ts. A colleague in Slack simply gets to read it.
 *
 * The board is read off the item rather than assumed, so an id from either
 * dev board resolves to a correct link.
 */
export async function getItemUpdates(
  itemId: string,
  limit = 20,
): Promise<{ id: string; name: string; url: string; updates: DevItemUpdate[] } | null> {
  if (!config.monday.live) {
    return {
      id: itemId,
      name: "[stub] VLookUp Template not working",
      url: itemUrl(itemId, "jetpackapps"),
      updates: [
        {
          at: new Date().toISOString(),
          author: "Dev (stub)",
          text: "Reproduced locally — webhook registration races the recipe save. Fix queued.",
          replies: [],
        },
      ],
    };
  }
  const data = await gql<{
    items: {
      id: string;
      name: string;
      board: { id: string } | null;
      updates: {
        created_at: string;
        text_body: string | null;
        creator: { name: string } | null;
        replies: { created_at: string; text_body: string | null; creator: { name: string } | null }[];
      }[];
    }[];
  }>(
    `query ($ids: [ID!], $limit: Int!) {
      items(ids: $ids) {
        id
        name
        board { id }
        updates(limit: $limit) {
          created_at
          text_body
          creator { name }
          replies { created_at text_body creator { name } }
        }
      }
    }`,
    { ids: [itemId], limit },
  ).catch(() => null);

  const item = data?.items?.[0];
  if (!item) return null;
  const clean = (t: string | null) => (t ?? "").replace(/\s+\n/g, "\n").trim();
  return {
    id: item.id,
    name: item.name,
    url: `${config.monday.accountUrl}/boards/${item.board?.id ?? ""}/pulses/${item.id}`,
    updates: (item.updates ?? [])
      .filter((u) => clean(u.text_body))
      .map((u) => ({
        at: u.created_at,
        author: u.creator?.name ?? "unknown",
        text: clean(u.text_body),
        replies: (u.replies ?? [])
          .filter((r) => clean(r.text_body))
          .map((r) => ({ at: r.created_at, author: r.creator?.name ?? "unknown", text: clean(r.text_body) })),
      })),
  };
}

export interface DevItemOutcome {
  id: string;
  name: string;
  /** Board group — "Done", "Client reported Field Issues", "Deployed To Prod"… */
  group: string | null;
  /** The "Dev Status" column, whatever the board calls its id. */
  devStatus: string | null;
  /** Oldest first, so the thread reads as it happened. */
  updates: DevItemUpdate[];
}

/**
 * What became of dev items: their status and engineering's whole thread.
 *
 * For the /performance handoff judge, which decides from this whether a ticket
 * Jetta escalated was a real bug or something she should have known. The two
 * boards give "Dev Status" different column ids, so it is found by title. A
 * failed read returns nothing rather than throwing: a verdict without the dev
 * thread is weaker, not wrong, and the Freshdesk side still carries evidence.
 */
export async function getDevItemOutcomes(itemIds: string[]): Promise<DevItemOutcome[]> {
  const ids = [...new Set(itemIds)].filter((id) => /^\d+$/.test(id));
  if (!ids.length || !config.monday.live) return [];
  const data = await gql<{
    items: {
      id: string;
      name: string;
      group: { title: string } | null;
      column_values: { text: string | null; column: { title: string } | null }[];
      updates: {
        created_at: string;
        text_body: string | null;
        creator: { name: string } | null;
        replies: { created_at: string; text_body: string | null; creator: { name: string } | null }[];
      }[];
    }[];
  }>(
    `query ($ids: [ID!]) {
      items(ids: $ids) {
        id
        name
        group { title }
        column_values { text column { title } }
        updates(limit: 40) {
          created_at
          text_body
          creator { name }
          replies { created_at text_body creator { name } }
        }
      }
    }`,
    { ids },
  ).catch(() => null);
  const clean = (t: string | null) => (t ?? "").replace(/\s+\n/g, "\n").trim();
  return (data?.items ?? []).map((item) => ({
    id: item.id,
    name: item.name,
    group: item.group?.title ?? null,
    devStatus: item.column_values.find((c) => c.column?.title === "Dev Status")?.text || null,
    updates: [...(item.updates ?? [])]
      .reverse()
      .filter((u) => clean(u.text_body))
      .map((u) => ({
        at: u.created_at,
        author: u.creator?.name ?? "unknown",
        text: clean(u.text_body),
        replies: (u.replies ?? [])
          .filter((r) => clean(r.text_body))
          .map((r) => ({ at: r.created_at, author: r.creator?.name ?? "unknown", text: clean(r.text_body) })),
      })),
  }));
}

/**
 * Dev items that link to each Freshdesk ticket, from both boards, newest first
 * back to `sinceIso`.
 *
 * Jetta's notes name the items she filed, but not the ones a person filed for
 * the same ticket, nor older items she matched without quoting an id — and a
 * judge that sees "no dev item" where engineering actually answered gets the
 * verdict wrong (ticket 13756: a tracked bug read as "unresolved"). The item
 * side is reliable: every dev item carries its ticket link. Two boards of a few
 * pages each since launch, so one scan per sync run is cheap.
 */
export interface TicketDevItems {
  itemIds: string[];
  /** Items Jetta filed herself — createDevItem's "Product: / Account: / Freshdesk ticket:" header. */
  jettaFiled: string[];
  /** Earliest creation time among Jetta's items: the handoff time when her note is missing. */
  jettaFiledAt: string | null;
}

/** The header createDevItem writes as an item's first update. */
const JETTA_ITEM_HEADER = /Product: .*\n\s*Account: .*\n\s*Freshdesk ticket:/;

export async function devItemsByTicket(sinceIso: string): Promise<Map<string, TicketDevItems>> {
  const out = new Map<string, TicketDevItems>();
  if (!config.monday.live) return out;
  type Page = { cursor: string | null; items: { id: string; created_at: string; column_values: { text: string | null }[]; updates: { text_body: string | null }[] }[] };
  const fields = `cursor items { id created_at column_values { text } updates(limit: 5) { text_body } }`;
  for (const boardId of [config.monday.boardIds.jetpackapps, config.monday.boardIds.getsign]) {
    if (!boardId) continue;
    let page: Page | null = (
      await gql<{ boards: { items_page: Page }[] }>(
        `query ($id: [ID!]) { boards(ids: $id) { items_page(limit: 100, query_params: { order_by: [{ column_id: "__creation_log__", direction: desc }] }) { ${fields} } } }`,
        { id: [boardId] },
      ).catch(() => null)
    )?.boards?.[0]?.items_page ?? null;
    for (let guard = 0; page && guard < 10; guard++) {
      let reachedOld = false;
      for (const item of page.items) {
        if (item.created_at < sinceIso) {
          reachedOld = true;
          continue;
        }
        const text = [...item.column_values.map((c) => c.text ?? ""), ...item.updates.map((u) => u.text_body ?? "")].join(" ");
        const byJetta = item.updates.some((u) => JETTA_ITEM_HEADER.test(u.text_body ?? ""));
        for (const m of text.matchAll(/\/tickets\/(\d+)(?![0-9])/g)) {
          const entry = out.get(m[1]) ?? { itemIds: [], jettaFiled: [], jettaFiledAt: null };
          if (!entry.itemIds.includes(item.id)) entry.itemIds.push(item.id);
          if (byJetta && !entry.jettaFiled.includes(item.id)) {
            entry.jettaFiled.push(item.id);
            if (!entry.jettaFiledAt || item.created_at < entry.jettaFiledAt) entry.jettaFiledAt = item.created_at;
          }
          out.set(m[1], entry);
        }
      }
      if (reachedOld || !page.cursor) break;
      page = (
        await gql<{ next_items_page: Page }>(`query ($c: String!) { next_items_page(limit: 100, cursor: $c) { ${fields} } }`, { c: page.cursor }).catch(() => null)
      )?.next_items_page ?? null;
    }
  }
  return out;
}

// ── Playbook cleanup ───────────────────────────────────────────────

/** A dev-board item the test playbook created, found by its [TEST] name. */
export interface TestDevItem {
  id: string;
  name: string;
  boardId: string;
  url: string;
}

const TEST_MARKER = "[TEST]";

/**
 * Every item on either dev board whose NAME carries the [TEST] marker — the
 * marker the playbook rules make testers put in their subjects, which
 * createDevItem copies into the item title. Used by /testing's auto-cleanup
 * to offer exactly these for deletion and nothing else.
 *
 * Filtered here rather than via monday's contains_text rule: the boards are
 * small (one page), and doing the match in code keeps the delete-side guard
 * and the scan using the identical predicate.
 */
export async function listTestDevItems(): Promise<TestDevItem[]> {
  if (!config.monday.live) return [];
  const boards = [config.monday.boardIds.jetpackapps, config.monday.boardIds.getsign].filter(
    (b): b is string => !!b,
  );
  const data = await gql<{
    boards: { id: string; items_page: { items: { id: string; name: string }[] } }[];
  }>(
    `query ($boards: [ID!]) {
      boards(ids: $boards) {
        id
        items_page(limit: 200) { items { id name } }
      }
    }`,
    { boards },
  ).catch(() => null);

  return (data?.boards ?? []).flatMap((b) =>
    b.items_page.items
      .filter((i) => i.name.includes(TEST_MARKER))
      .map((i) => ({
        id: i.id,
        name: i.name,
        boardId: b.id,
        url: `${config.monday.accountUrl}/boards/${b.id}/pulses/${i.id}`,
      })),
  );
}

/**
 * Delete ONE dev-board item, and only a [TEST] one. The name is re-fetched
 * and re-checked here rather than trusted from the caller: deletion is the
 * single irreversible write in this file, so the guard lives next to the
 * mutation, not in whoever assembled the list.
 */
export async function deleteTestDevItem(itemId: string): Promise<{ deleted: boolean; reason?: string }> {
  if (!config.monday.live) {
    console.log(`[stub] delete_item ${itemId}`);
    return { deleted: false, reason: "monday is stubbed in this environment" };
  }
  if (!config.monday.allowWrites) {
    console.log(`[MONDAY_ALLOW_WRITES=false] would delete item ${itemId} — no write made.`);
    return { deleted: false, reason: "monday writes are disabled" };
  }
  if (!/^\d+$/.test(itemId)) return { deleted: false, reason: "not a monday item id" };

  const check = await gql<{ items: { id: string; name: string }[] }>(
    `query ($item: [ID!]) { items(ids: $item) { id name } }`,
    { item: [itemId] },
  ).catch(() => null);
  const name = check?.items?.[0]?.name;
  if (!name) return { deleted: false, reason: "item not found" };
  if (!name.includes(TEST_MARKER)) {
    return { deleted: false, reason: `"${name}" does not carry ${TEST_MARKER} — refusing to delete` };
  }

  await gql<{ delete_item: { id: string } }>(
    `mutation ($item: ID!) { delete_item(item_id: $item) { id } }`,
    { item: itemId },
  );
  return { deleted: true };
}

// Trial extension + discounts moved to lib/tools/monday-monetization.ts — they
// use the Marketplace monetization API (app collaborator token), not the
// board GraphQL client above.
