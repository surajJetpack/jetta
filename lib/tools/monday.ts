/**
 * monday.com tool client — Dev board search / create / +1 (board GraphQL API,
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

function progressOf(columns: MondayColumnValue[] | undefined): string {
  for (const title of PROGRESS_COLUMN_TITLES) {
    const hit = (columns ?? []).find(
      (c) => c.type === "status" && c.column?.title?.trim().toLowerCase() === title,
    );
    if (hit?.text?.trim()) return hit.text.trim();
  }
  return "unknown";
}

export async function searchDevBoard(symptom: string, product: Product): Promise<DevBoardItem[]> {
  if (!config.monday.live) {
    if (/mapping|map|column/i.test(symptom)) {
      return [
        {
          id: "5566778899",
          title: "[GetSign] Mapping editor: confirm-on-close UX confusion",
          status: "Working on it",
          url: itemUrl("5566778899", "getsign"),
        },
      ];
    }
    return [];
  }

  // Fetch board items and score by token overlap with the symptom. monday's
  // native contains_text is a strict substring match on the full phrase, which
  // misses near-matches (e.g. "signed document syncing" vs "...not syncing...")
  // — and missing an existing item would make Jetta file a duplicate.
  const board = boardIdFor(product);
  const data = await gql<{
    boards: {
      items_page: { items: { id: string; name: string; column_values: MondayColumnValue[] }[] };
    }[];
  }>(
    `query ($board: [ID!]) {
      boards(ids: $board) {
        items_page(limit: 100) {
          items { id name column_values { text type column { title } } }
        }
      }
    }`,
    { board: [board] },
  ).catch(() => null);

  const items = data?.boards?.[0]?.items_page?.items ?? [];
  const terms = symptom
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
  if (!terms.length) return [];

  return items
    .map((i) => {
      const name = i.name.toLowerCase();
      const score = terms.reduce((s, t) => s + (name.includes(t) ? 1 : 0), 0);
      return { i, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ i }) => ({
      id: i.id,
      title: i.name,
      status: progressOf(i.column_values),
      url: itemUrl(i.id, product),
    }));
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
export type CreatedDevItem = DevBoardItem & { filesAttached: string[] };

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

  // Discover the board's columns so we can populate structured fields by title,
  // adapting to whatever board is configured (test board or real bug tracker).
  const meta = await gql<{
    boards: { columns: { id: string; title: string; type: string }[] }[];
  }>(`query ($board: [ID!]) { boards(ids: $board) { columns { id title type } } }`, {
    board: [board],
  }).catch(() => null);
  const cols = meta?.boards?.[0]?.columns ?? [];
  const find = (type: string, kw: RegExp) =>
    cols.find((c) => c.type === type && kw.test(c.title.toLowerCase()))?.id;

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

  const data = await gql<{ create_item: { id: string; name: string } }>(
    `mutation ($board: ID!, $name: String!, $cv: JSON!) {
      create_item(board_id: $board, item_name: $name, column_values: $cv) { id name }
    }`,
    { board, name: input.title, cv: JSON.stringify(cv) },
  );
  const id = data.create_item.id;

  // Also post the full context as an update — keeps product/ticket visible and
  // covers boards that lack matching columns.
  const body = [
    `Product: ${input.product}`,
    `Account: ${input.accountUrl}`,
    `Freshdesk ticket: ${input.freshdeskTicketUrl}`,
    "",
    `Error: ${input.errorDescription}`,
    "",
    `Reproduction steps:\n${input.reproSteps}`,
  ].join("\n");
  const update = await gql<{ create_update: { id: string } }>(
    `mutation ($item: ID!, $body: String!) { create_update(item_id: $item, body: $body) { id } }`,
    { item: id, body },
  ).catch(() => null);

  // Screenshots hang off that update — it's the one place on the item guaranteed
  // to exist regardless of which columns the configured board happens to have.
  const filesAttached = await attachFilesToUpdate(
    update?.create_update.id ?? null,
    input.attachments ?? [],
  );

  return { id, title: input.title, status: "New", url: itemUrl(id, input.product), filesAttached };
}

/**
 * Does this dev item already reference this ticket?
 *
 * The guard against Jetta "+1"-ing an item with the very ticket that created
 * it. `createDevItem` writes "Freshdesk ticket: <url>" into the item's first
 * update, and humans filing bugs paste the ticket link the same way — so one
 * scan of the updates and column text catches both.
 *
 * Matches the ticket id only in ticket-shaped contexts (`/tickets/13894`,
 * `#13894`); a bare number would collide with account ids, order numbers, and
 * anything else in a bug report. Fails OPEN (returns false) — a monday read
 * blip should not block a legitimate +1.
 */
export async function itemMentionsTicket(itemId: string, ticketId: string): Promise<boolean> {
  if (!config.monday.live) return false;
  const data = await gql<{
    items: { updates: { body: string }[]; column_values: { text: string | null }[] }[];
  }>(
    `query ($ids: [ID!]) {
      items(ids: $ids) { updates(limit: 50) { body } column_values { text } }
    }`,
    { ids: [itemId] },
  ).catch(() => null);
  if (!data?.items?.[0]) return false;

  const haystack = [
    ...data.items[0].updates.map((u) => u.body ?? ""),
    ...data.items[0].column_values.map((c) => c.text ?? ""),
  ].join("\n");
  const id = ticketId.replace(/^#/, "");
  return new RegExp(`(/tickets/|#)${id}\\b`).test(haystack);
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
 * Deliberately NOT offered to the ticket agent, only to the Slack assistant.
 * These are internal engineering notes ("this is a race in the webhook
 * registration, punting to next sprint") and the ticket agent's whole job is
 * writing to customers; one careless paraphrase and a customer is reading our
 * sprint planning. A colleague in Slack has every right to see it.
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

export interface PlusOneInput {
  itemId: string;
  /** Deep link to the interaction (Freshdesk ticket or chat transcript). */
  ticketUrl: string;
  product: Product;
  /** One line on what this customer actually saw — the +1's whole payload. */
  symptom: string;
  /** Who reported it, for a dev who can't open the ticket link. */
  accountLabel?: string;
  attachments?: AttachmentFile[];
}

/**
 * Add a "+1 / me too" note to an existing dev item, with this reporter's own
 * screenshots — a second user's evidence often shows the case the first didn't.
 *
 * The body carries the symptom and the account, not just a link: the assignee
 * on the Dev board may have no Freshdesk access at all, in which case a bare
 * ticket URL tells them precisely nothing (observed on item 12757964338).
 */
export async function addPlusOne(
  input: PlusOneInput,
): Promise<{ url: string; filesAttached: string[] }> {
  const { itemId, ticketUrl, product, symptom, accountLabel, attachments = [] } = input;
  const files = attachments.length ? ` (+${attachments.length} file${attachments.length === 1 ? "" : "s"})` : "";
  const body = [
    "+1 — another customer hit this.",
    `Symptom: ${symptom}`,
    accountLabel ? `Reported by: ${accountLabel}` : "",
    `Freshdesk ticket: ${ticketUrl}`,
  ]
    .filter(Boolean)
    .join("\n");

  if (!config.monday.live) {
    console.log(`[stub] +1 on item ${itemId}${files}:\n${body}`);
    return { url: itemUrl(itemId, product), filesAttached: [] };
  }
  if (!config.monday.allowWrites) {
    console.log(
      `[MONDAY_ALLOW_WRITES=false] would +1 item ${itemId}${files} — no write made.\n${body}`,
    );
    return { url: itemUrl(itemId, product), filesAttached: [] };
  }
  const update = await gql<{ create_update: { id: string } }>(
    `mutation ($item: ID!, $body: String!) { create_update(item_id: $item, body: $body) { id } }`,
    { item: itemId, body },
  );
  const filesAttached = await attachFilesToUpdate(update.create_update.id, attachments);
  return { url: itemUrl(itemId, product), filesAttached };
}

// Trial extension + discounts moved to lib/tools/monday-monetization.ts — they
// use the Marketplace monetization API (app collaborator token), not the
// board GraphQL client above.
