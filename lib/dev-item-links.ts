/**
 * Which Freshdesk ticket a monday item was filed for — remembered, so the
 * answer does not depend on how much has been said on the item since.
 *
 * The link is written on the item as text: in a column where the board has
 * one, and always in Jetta's first update ("Freshdesk ticket: …/tickets/123").
 * The GetSign board has no such column, so there the update is the only
 * place. And every read of an item's updates takes the NEWEST few — 5, 20 or
 * 50 depending on the caller — while that update is the OLDEST. Each chase,
 * relay and developer reply pushes it one further from the window. Once it is
 * out, the item is no longer "this ticket's item" to anything that asks:
 * the one-item-per-ticket guard files a second one, the ticket loses its
 * update_dev_item tool, the dev bridge finds no ticket to act on, and the
 * ticket follow-up can close a ticket whose item is still in flight.
 *
 * So the pair is kept here: written when Jetta files (or adds to) an item,
 * and learned from any item read while its filing update is still in view.
 * Readers lay it back onto the row as one more column value, which is the
 * shape the existing matchers (`itemCarriesTicket`, `ticketIdsOnItem`)
 * already read — they stay pure and unchanged.
 *
 * Best-effort on both sides: if the store cannot be read, the row is returned
 * exactly as monday gave it, and behaviour is what it was before.
 */
import { Redis } from "@upstash/redis";
import { config } from "./config";
import { isJettaContextPost } from "./jetta-posts";

const KEY = "jetta:devitem:tickets";

let redis: Redis | null = null;
function client(): Redis | null {
  if (config.kv.url && config.kv.token) {
    redis ??= new Redis({ url: config.kv.url, token: config.kv.token });
    return redis;
  }
  return null;
}
const mem = new Map<string, string>();

/**
 * Read-only mode, for a script's dry run. Reading rows learns links as a side
 * effect, so "list the live items" is itself a write unless this is on. While
 * it is, nothing is stored and the pairs that WOULD have been are collected.
 */
let readOnly: [string, string][] | null = null;
export function setLinksReadOnly(on: boolean): void {
  readOnly = on ? [] : null;
}
/** The pairs withheld since read-only mode was switched on. */
export function withheldLinks(): [string, string][] {
  return readOnly ? [...readOnly] : [];
}

/** Remember that `itemId` was filed for `ticketId`. Never throws. */
export async function rememberItemTicket(itemId: string, ticketId: string | null | undefined): Promise<void> {
  if (!ticketId || !/^\d+$/.test(itemId) || !/^\d+$/.test(ticketId)) return;
  if (readOnly) {
    if (!readOnly.some(([i]) => i === itemId)) readOnly.push([itemId, ticketId]);
    return;
  }
  try {
    const r = client();
    if (r) await r.hset(KEY, { [itemId]: ticketId });
    else mem.set(itemId, ticketId);
  } catch (e) {
    console.warn(`dev-item-links: could not remember ${itemId} → ${ticketId}:`, e instanceof Error ? e.message : e);
  }
}

/** Every remembered pair, item id → ticket id. Empty when the store is unreadable. */
export async function itemTickets(): Promise<Map<string, string>> {
  try {
    const r = client();
    if (!r) return new Map(mem);
    const all = (await r.hgetall<Record<string, string | number>>(KEY)) ?? {};
    // Upstash hands a numeric-looking value back as a number.
    return new Map(Object.entries(all).map(([item, ticket]) => [item, String(ticket)]));
  } catch (e) {
    console.warn("dev-item-links: could not read the stored links:", e instanceof Error ? e.message : e);
    return new Map();
  }
}

type Linkable = {
  id: string;
  column_values?: { text: string | null }[] | null;
  updates?: { text_body: string | null }[] | null;
};

/** The ticket named in the item's own filing context, if that update is in view. Pure. */
export function filedForTicket(row: Pick<Linkable, "updates">): string | null {
  // Oldest first: the original filing outranks a later "Follow-up from the SAME ticket".
  for (const u of [...(row.updates ?? [])].reverse()) {
    if (!isJettaContextPost(u.text_body)) continue;
    const m = /\/tickets\/(\d+)(?![0-9])/.exec(u.text_body ?? "");
    if (m) return m[1];
  }
  return null;
}

/** The text a stored link is laid onto a row as. Matches what the matchers look for. */
const asColumnText = (ticketId: string) => `Freshdesk ticket (remembered): /tickets/${ticketId}`;

/**
 * Lay stored links onto rows, and learn any that are visible but not stored.
 * Pure: returns the rows to use and the pairs to remember.
 */
export function applyLinks<T extends Linkable>(rows: T[], stored: Map<string, string>): { rows: T[]; learned: [string, string][] } {
  const learned: [string, string][] = [];
  const out = rows.map((row) => {
    const known = stored.get(row.id);
    if (known) {
      return { ...row, column_values: [...(row.column_values ?? []), { text: asColumnText(known), type: "text", column: { title: "Freshdesk ticket (remembered)" } }] } as T;
    }
    const seen = filedForTicket(row);
    if (seen) learned.push([row.id, seen]);
    return row;
  });
  return { rows: out, learned };
}

/**
 * The same, against the store: what every reader of board rows calls.
 * `stored` may be passed in by a caller that reads several pages.
 */
export async function withStoredLinks<T extends Linkable>(rows: T[], stored?: Map<string, string>): Promise<T[]> {
  if (!rows.length) return rows;
  const { rows: out, learned } = applyLinks(rows, stored ?? (await itemTickets()));
  for (const [item, ticket] of learned) await rememberItemTicket(item, ticket);
  return out;
}

/** Test helper: forget everything held in memory. */
export function resetItemTicketsForTest(): void {
  mem.clear();
}
