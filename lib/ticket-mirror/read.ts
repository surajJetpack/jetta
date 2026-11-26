/**
 * Reads from the Postgres ticket mirror for callers that would otherwise spend
 * Freshdesk API calls (40/min, shared by everything).
 *
 * Freshness is the whole question. The delta cursor in `sync_state` is the
 * updated_at of the last ticket the 5-minute sync finished, so every mirrored
 * ticket is accurate as of that moment. Each reader states what it needs:
 *  - `requireUpdatedAt`: the caller knows the ticket's FD updated_at (from a
 *    list call) and needs at least that version.
 *  - otherwise the mirror must be "live": cursor within MAX_LAG_MS of now.
 * Anything else returns null and the caller reads Freshdesk exactly as before.
 * Every function here returns null rather than throwing.
 */
import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import { config } from "../config";
import { getDb, schema } from "../db";
import { statusLabel } from "../tools/freshdesk";
import { customerMessageNeedsNoReply, type ThreadState } from "../reply-owed";

const { tickets, messages, agents, syncState } = schema;

/** A healthy sync runs every 5 min; allow two missed ticks before trusting FD instead. */
const MAX_LAG_MS = 15 * 60_000;
const CURSOR_TTL_MS = 30_000;

let cursorCache: { at: number; value: number | null } | null = null;

function enabled(): boolean {
  return config.ticketMirror !== "off" && !!getDb();
}

/** The time the mirror is accurate up to, or null when unknown. */
export async function mirrorAsOf(): Promise<number | null> {
  if (cursorCache && Date.now() - cursorCache.at < CURSOR_TTL_MS) return cursorCache.value;
  const db = getDb();
  if (!db) return null;
  try {
    const rows = await db
      .select()
      .from(syncState)
      .where(inArray(syncState.key, ["delta_cursor", "delta_caught_up_at"]));
    const times = rows.map((r) => Date.parse(r.value as string)).filter(Number.isFinite);
    const value = times.length ? Math.max(...times) : null;
    cursorCache = { at: Date.now(), value };
    return value;
  } catch {
    return null;
  }
}

async function live(): Promise<boolean> {
  const asOf = await mirrorAsOf();
  return asOf !== null && Date.now() - asOf < MAX_LAG_MS;
}

export interface MirrorFreshness {
  /** The caller knows this FD updated_at for the ticket; the mirror must have it. */
  requireUpdatedAt?: string;
}

async function freshTicket(ticketId: number, f: MirrorFreshness) {
  if (!enabled()) return null;
  const db = getDb()!;
  try {
    const [row] = await db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1);
    if (!row) return null;
    if (f.requireUpdatedAt) {
      if (Date.parse(row.updatedAt) < Date.parse(f.requireUpdatedAt)) return null;
    } else if (!(await live())) {
      return null;
    }
    return row;
  } catch {
    return null;
  }
}

const toUnix = (iso: string | null | undefined) => (iso ? Math.floor(Date.parse(iso) / 1000) : null);

/**
 * Where the ticket stands by its thread: status label, whose turn it is, and
 * when each side last wrote. See lib/reply-owed.ts for why the thread wins.
 */
export async function mirrorTicketState(ticketId: string): Promise<ThreadState | null> {
  const row = await freshTicket(Number(ticketId), {});
  if (!row) return null;
  // No public message yet counts as owed (same rule as awaitsOurReply).
  let awaitingReply = row.lastPublicFrom ? row.lastPublicFrom === "customer" : true;
  if (row.lastPublicFrom === "customer") {
    try {
      const [last] = await getDb()!
        .select({ bodyClean: messages.bodyClean, bodyText: messages.bodyText })
        .from(messages)
        .where(and(eq(messages.ticketId, row.id), eq(messages.private, false)))
        .orderBy(desc(messages.createdAt), desc(messages.idx))
        .limit(1);
      const body = last?.bodyClean ?? last?.bodyText ?? "";
      if (body && customerMessageNeedsNoReply(body)) awaitingReply = false;
    } catch {
      // Keep "owed": a read failure must not hide a waiting customer.
    }
  }
  return {
    status: statusLabel(row.status),
    awaitingReply,
    lastCustomerAt: toUnix(row.lastCustomerAt),
    lastAgentAt: toUnix(row.lastAgentAt),
  };
}

/** One ticket whose customer wrote last, straight from the mirror. */
export interface MirrorWaitingTicket {
  id: string;
  subject: string;
  product: string | null;
  status: string;
}

/**
 * Every ticket whose newest public message is the customer's, written within
 * `sinceDays`, whatever its status says. This is how /today finds the tickets
 * a person marked resolved or "waiting on customer" while the customer was
 * still waiting: Jetta's own run history never hears about those.
 *
 * Null when the mirror is off or behind; the caller then has only its own
 * history to go on, as before.
 */
export async function mirrorCustomerWaiting(sinceDays: number, limit = 150): Promise<MirrorWaitingTicket[] | null> {
  if (!enabled() || !(await live())) return null;
  try {
    const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
    const rows = await getDb()!
      .select({ id: tickets.id, subject: tickets.subject, product: tickets.product, status: tickets.status })
      .from(tickets)
      .where(
        and(
          eq(tickets.lastPublicFrom, "customer"),
          gte(tickets.lastCustomerAt, since),
          eq(tickets.spam, false),
          eq(tickets.deleted, false),
        ),
      )
      .orderBy(desc(tickets.lastCustomerAt))
      .limit(limit);
    return rows.map((r) => ({ id: String(r.id), subject: r.subject, product: r.product, status: statusLabel(r.status) }));
  } catch {
    return null;
  }
}

/** A ticket's conversations (opening message excluded) in Freshdesk's API shape. */
export interface MirrorConversation {
  private: boolean;
  incoming: boolean;
  user_id?: number;
  created_at: string;
  body_text?: string;
  from_email?: string;
}

export async function mirrorConversations(
  ticketId: number,
  f: MirrorFreshness = {},
): Promise<{ conversations: MirrorConversation[]; description: string | null } | null> {
  const row = await freshTicket(ticketId, f);
  if (!row) return null;
  try {
    const rows = await getDb()!
      .select()
      .from(messages)
      .where(eq(messages.ticketId, ticketId))
      .orderBy(asc(messages.idx));
    const opening = rows.find((m) => m.idx === 0);
    // A thread with a hole in it (an interrupted sync) is not a thread to trust.
    if (!opening || rows.length !== row.messageCount) return null;
    return {
      description: opening.bodyText ?? null,
      conversations: rows
        .filter((m) => m.idx > 0)
        .map((m) => ({
          private: m.private,
          incoming: m.incoming,
          user_id: m.userId ?? undefined,
          created_at: new Date(m.createdAt).toISOString().replace(".000Z", "Z"),
          body_text: m.bodyText ?? undefined,
          from_email: m.fromEmail ?? undefined,
        })),
    };
  } catch {
    return null;
  }
}

/** First public agent reply at or after `sinceIso`, or undefined when the mirror can't say. */
export async function mirrorAgentReplyAfter(
  ticketId: string,
  sinceIso: string,
): Promise<{ body: string; userId: number; createdAt: string } | null | undefined> {
  const thread = await mirrorConversations(Number(ticketId));
  if (!thread) return undefined;
  const reply = thread.conversations
    .filter((c) => !c.incoming && !c.private && c.created_at >= sinceIso)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
  if (!reply) return null;
  return { body: reply.body_text ?? "", userId: reply.user_id ?? 0, createdAt: reply.created_at };
}

/** Agent id → name from the mirror (refreshed daily by the sync), or null if empty. */
export async function mirrorAgentNames(ids?: number[]): Promise<Map<number, string> | null> {
  if (!enabled()) return null;
  try {
    const db = getDb()!;
    const rows = ids?.length
      ? await db.select().from(agents).where(inArray(agents.id, ids))
      : await db.select().from(agents);
    if (!rows.length) return null;
    return new Map(rows.map((a) => [a.id, a.name ?? `Agent ${a.id}`]));
  } catch {
    return null;
  }
}
