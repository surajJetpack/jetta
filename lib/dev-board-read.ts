/**
 * Reads the two monday dev boards into DevItem records for /dev-board.
 *
 * Three reads per board, all cheap (measured 2026-10-13: ~1 s per 100 items,
 * ~380 Dev Status changes per board per 90 days):
 *  1. items ordered by Last Updated, newest first, until one is older than the
 *     window — everything that moved recently, in whatever group;
 *  2. every item in a LIVE group (not Done / Deployed / Archive), however old —
 *     the stale open work a "last updated" read would never reach;
 *  3. the activity log since the cursor: Dev Status changes and group moves,
 *     which is the only record of WHEN an item started and finished.
 *
 * Comments are read per item only when the item's updated_at moved since the
 * last read, 25 items to a query, so a steady-state run costs a few calls.
 *
 * Read-only. Nothing here writes to monday.
 */
import { config } from "./config";
import type { BoardKey, DevItem, DevPost, StatusChange } from "./dev-board";

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: config.monday.apiToken ?? "",
      "API-Version": "2024-10",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[]; error_message?: string };
  if (json.errors?.length) throw new Error(`monday: ${json.errors.map((e) => e.message).join("; ")}`);
  if (!json.data) throw new Error(`monday: ${json.error_message ?? `HTTP ${res.status}`}`);
  return json.data;
}

/** Groups whose items are finished. Mirrors CLOSED_GROUP in lib/tools/monday.ts. */
export const CLOSED_GROUP_RE = /^(done|deployed|archive)/i;

/** Columns read on every item, by id — the same ids on both boards (read 2026-10-13). */
const COLUMN_IDS = ["status", "person", "people", "status_14", "status_16", "status_1", "multiple_person_mkv98ykd", "people2"];

interface RawItem {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  creator: { name: string } | null;
  group: { id: string; title: string } | null;
  column_values: { id: string; text: string | null }[];
}

interface RawUpdate {
  id: string;
  created_at: string;
  creator: { name: string } | null;
  text_body: string | null;
  replies: { id: string; created_at: string; creator: { name: string } | null; text_body: string | null }[] | null;
}

interface ItemsPage {
  cursor: string | null;
  items: RawItem[];
}

const ITEM_FIELDS = `id name created_at updated_at creator { name } group { id title }
  column_values(ids: ${JSON.stringify(COLUMN_IDS)}) { id text }`;

/** One post's text, as stored: whitespace folded, capped. The miner reads these. */
const POST_CHARS = 1500;
const clean = (t: string | null | undefined) => (t ?? "").replace(/\s+/g, " ").trim().slice(0, POST_CHARS);

function people(text: string | null | undefined): string[] {
  return (text ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function toItem(raw: RawItem, board: BoardKey, boardId: string): Omit<DevItem, "posts" | "changes"> {
  const col = (id: string) => raw.column_values.find((c) => c.id === id)?.text?.trim() || null;
  return {
    id: String(raw.id),
    board,
    boardId,
    name: raw.name,
    url: `${config.monday.accountUrl}/boards/${boardId}/pulses/${raw.id}`,
    group: raw.group?.title ?? "",
    status: col("status"),
    developers: people(col("person")),
    reviewers: [...people(col("multiple_person_mkv98ykd")), ...people(col("people2"))],
    reporter: col("people"),
    priority: col("status_14"),
    type: col("status_16"),
    project: col("status_1"),
    createdAt: Date.parse(raw.created_at),
    updatedAt: Date.parse(raw.updated_at),
    creator: raw.creator?.name ?? null,
  };
}

/** Items touched since `sinceMs`, newest first, plus every item in a live group. */
async function readBoardItems(boardId: string, sinceMs: number): Promise<RawItem[]> {
  const out = new Map<string, RawItem>();
  let cursor: string | null = null;
  // 1. Recently touched, by Last Updated. 20 pages is 2,000 items — more than either board holds in a window.
  for (let page = 0; page < 20; page++) {
    const d: { boards: { items_page: { cursor: string | null; items: RawItem[] } }[] } | { next_items_page: { cursor: string | null; items: RawItem[] } } =
      cursor
        ? await gql(`query ($c: String!) { next_items_page(limit: 100, cursor: $c) { cursor items { ${ITEM_FIELDS} } } }`, { c: cursor })
        : await gql(
            `query ($b: [ID!]) { boards(ids: $b) { items_page(limit: 100, query_params: { order_by: [{ column_id: "__last_updated__", direction: desc }] }) { cursor items { ${ITEM_FIELDS} } } } }`,
            { b: [boardId] },
          );
    const pageData: ItemsPage | undefined = "next_items_page" in d ? d.next_items_page : d.boards[0]?.items_page;
    if (!pageData) break;
    let older = false;
    for (const it of pageData.items) {
      if (Date.parse(it.updated_at) < sinceMs) older = true;
      else out.set(String(it.id), it);
    }
    cursor = pageData.cursor;
    if (older || !cursor) break;
  }
  // 2. Every live group in full — old open work is exactly what "stale" means.
  const g = await gql<{ boards: { groups: { id: string; title: string }[] }[] }>(
    `query ($b: [ID!]) { boards(ids: $b) { groups { id title } } }`,
    { b: [boardId] },
  );
  const live = (g.boards[0]?.groups ?? []).filter((x) => !CLOSED_GROUP_RE.test(x.title.trim())).map((x) => x.id);
  for (const groupId of live) {
    let c: string | null = null;
    for (let page = 0; page < 10; page++) {
      const d: { boards: { groups: { items_page: { cursor: string | null; items: RawItem[] } }[] }[] } | { next_items_page: { cursor: string | null; items: RawItem[] } } =
        c
          ? await gql(`query ($c: String!) { next_items_page(limit: 100, cursor: $c) { cursor items { ${ITEM_FIELDS} } } }`, { c })
          : await gql(
              `query ($b: [ID!], $g: [String]) { boards(ids: $b) { groups(ids: $g) { items_page(limit: 100) { cursor items { ${ITEM_FIELDS} } } } } }`,
              { b: [boardId], g: [groupId] },
            );
      const pageData: ItemsPage | undefined = "next_items_page" in d ? d.next_items_page : d.boards[0]?.groups[0]?.items_page;
      if (!pageData) break;
      for (const it of pageData.items) out.set(String(it.id), it);
      c = pageData.cursor;
      if (!c) break;
    }
  }
  return [...out.values()];
}

/** Comments (with replies) for these items, oldest first. 25 items a query. */
export async function readPosts(itemIds: string[]): Promise<Map<string, DevPost[]>> {
  const out = new Map<string, DevPost[]>();
  for (let i = 0; i < itemIds.length; i += 25) {
    const ids = itemIds.slice(i, i + 25);
    const d = await gql<{ items: { id: string; updates: RawUpdate[] }[] }>(
      `query ($ids: [ID!]) { items(ids: $ids) { id updates(limit: 50) { id created_at creator { name } text_body
        replies { id created_at creator { name } text_body } } } }`,
      { ids },
    );
    for (const it of d.items) {
      const posts: DevPost[] = [];
      for (const u of it.updates ?? []) {
        posts.push({ id: String(u.id), at: Date.parse(u.created_at), who: u.creator?.name ?? "", text: clean(u.text_body) });
        for (const r of u.replies ?? []) {
          posts.push({ id: String(r.id), at: Date.parse(r.created_at), who: r.creator?.name ?? "", text: clean(r.text_body), parentId: String(u.id) });
        }
      }
      out.set(String(it.id), posts.filter((p) => Number.isFinite(p.at)).sort((a, b) => a.at - b.at));
    }
  }
  return out;
}

interface RawLog {
  event: string;
  created_at: string;
  user_id: string;
  data: string;
}

/**
 * Dev Status changes and group moves since `fromIso`, keyed by item id.
 * created_at on a log is in 1e-7 s.
 */
async function readChanges(boardId: string, fromIso: string, users: Map<string, string>): Promise<Map<string, StatusChange[]>> {
  const out = new Map<string, StatusChange[]>();
  for (let page = 1; page <= 20; page++) {
    const d = await gql<{ boards: { activity_logs: RawLog[] | null }[] }>(
      `query ($b: [ID!], $f: ISO8601DateTime, $p: Int) { boards(ids: $b) { activity_logs(from: $f, limit: 1000, page: $p) { event created_at user_id data } } }`,
      { b: [boardId], f: fromIso, p: page },
    );
    const logs = d.boards[0]?.activity_logs ?? [];
    for (const log of logs) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(log.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const item = data.pulse_id != null ? String(data.pulse_id) : null;
      if (!item) continue;
      const at = Math.round(Number(log.created_at) / 10_000);
      const by = users.get(String(log.user_id)) ?? "";
      let change: StatusChange | null = null;
      if (log.event === "update_column_value" && data.column_id === "status") {
        const to = (data.value as { label?: { text?: string } } | null)?.label?.text;
        if (to) change = { at, kind: "status", to, by };
      } else if (log.event === "move_pulse_into_group") {
        const to = (data.dest_group as { title?: string } | undefined)?.title;
        if (to) change = { at, kind: "group", to, by };
      }
      if (!change) continue;
      const list = out.get(item) ?? [];
      list.push(change);
      out.set(item, list);
    }
    if (logs.length < 1000) break;
  }
  return out;
}

async function readUsers(): Promise<Map<string, string>> {
  const d = await gql<{ users: { id: string; name: string }[] }>(`query { users(limit: 500) { id name } }`, {});
  return new Map(d.users.map((u) => [String(u.id), u.name]));
}

export interface BoardRead {
  items: Omit<DevItem, "posts" | "changes">[];
  changes: Map<string, StatusChange[]>;
  /** The token's own user — Jetta posts through it. */
  self: string;
  boardNames: Record<string, string>;
}

/** Everything but comments, both boards. Comments are read separately, only for items that moved. */
export async function readBoards(sinceMs: number, changesFromIso: string): Promise<BoardRead> {
  if (!config.monday.apiToken) throw new Error("MONDAY_API_TOKEN is not set.");
  const boards = (Object.entries(config.monday.boardIds) as [BoardKey, string | undefined][]).filter(
    (e): e is [BoardKey, string] => !!e[1],
  );
  const [users, me, names] = await Promise.all([
    readUsers(),
    gql<{ me: { name: string } }>(`query { me { name } }`, {}),
    gql<{ boards: { id: string; name: string }[] }>(`query ($b: [ID!]) { boards(ids: $b) { id name } }`, { b: boards.map((b) => b[1]) }),
  ]);
  const items: BoardRead["items"] = [];
  const changes = new Map<string, StatusChange[]>();
  for (const [key, id] of boards) {
    const [raw, ch] = await Promise.all([readBoardItems(id, sinceMs), readChanges(id, changesFromIso, users)]);
    for (const r of raw) items.push(toItem(r, key, id));
    for (const [k, v] of ch) changes.set(k, [...(changes.get(k) ?? []), ...v]);
  }
  return {
    items,
    changes,
    self: me.me.name,
    boardNames: Object.fromEntries(names.boards.map((b) => [String(b.id), b.name])),
  };
}
