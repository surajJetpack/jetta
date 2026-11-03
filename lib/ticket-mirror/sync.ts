/**
 * Keeps Postgres in step with Freshdesk.
 *
 * Two loops, both run by /api/cron/ticket-sync:
 *  - delta: every ticket updated since the last cursor (1 list call per 100
 *    changed tickets, then ~1 call per ticket for its new messages). This is
 *    also how agent replies and status changes made in the FD UI arrive — FD
 *    sends no webhook for those.
 *  - backfill: the same walk over history, from BACKFILL_DAYS ago, using only
 *    budget the delta left over. It finishes on its own and then stops.
 *
 * Everything here is background work: it yields to customer-facing paths via
 * `waitForHeadroom` and never retries past its deadline. Every write is an
 * idempotent upsert keyed by Freshdesk ids, so re-syncing a ticket is harmless.
 */
import { eq, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "../db";
import { cleanEmailText } from "../email-clean";
import { countInlineImages, fd, stripHtml } from "../tools/freshdesk";
import { waitForHeadroom } from "../tools/fd-budget";
import { bumpDataVersion } from "../data-version";

const { tickets, messages, attachments, contacts, agents, syncState } = schema;

const LIST_PAGE = 100;
const CONV_PAGE = 100;
/** Background calls stop when fewer than this many remain in the minute. */
const RESERVE = 15;
export const BACKFILL_DAYS = 180;

/** How long a background step may wait for budget: until the run's deadline, else 30s. */
function maxWait(deadline?: number): number {
  return deadline ? Math.max(0, deadline - Date.now()) : 30_000;
}

// ── Freshdesk shapes (only the fields we keep) ──────────────────────

type FDAttachment = { id: number; name: string; content_type?: string; size?: number };

export type FDListTicket = {
  id: number;
  subject?: string;
  status: number;
  priority?: number;
  source?: number;
  type?: string | null;
  tags?: string[];
  requester_id?: number;
  responder_id?: number | null;
  group_id?: number | null;
  company_id?: number | null;
  to_emails?: string[] | null;
  spam?: boolean;
  custom_fields?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  requester?: { id: number; name?: string; email?: string };
};

type FDTicket = FDListTicket & {
  description?: string;
  description_text?: string;
  attachments?: FDAttachment[];
  cc_emails?: string[];
};

type FDConversation = {
  id: number;
  body?: string;
  body_text?: string;
  incoming: boolean;
  private: boolean;
  source?: number;
  user_id?: number;
  from_email?: string;
  to_emails?: string[];
  cc_emails?: string[];
  attachments?: FDAttachment[];
  created_at: string;
  updated_at?: string;
};

// ── State ───────────────────────────────────────────────────────────

async function getState<T>(db: Db, key: string): Promise<T | null> {
  const rows = await db.select().from(syncState).where(eq(syncState.key, key)).limit(1);
  return (rows[0]?.value as T) ?? null;
}

async function setState(db: Db, key: string, value: unknown): Promise<void> {
  await db
    .insert(syncState)
    .values({ key, value })
    .onConflictDoUpdate({ target: syncState.key, set: { value, updatedAt: sql`now()` } });
}

// ── Upserts ─────────────────────────────────────────────────────────

/** `set` clause that copies every listed column from the incoming row. */
function excluded(cols: string[]): Record<string, ReturnType<typeof sql>> {
  return Object.fromEntries(cols.map((c) => [c, sql.raw(`excluded."${toSnake(c)}"`)]));
}
function toSnake(s: string): string {
  return s.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}

function ticketRow(t: FDListTicket) {
  return {
    id: t.id,
    subject: t.subject ?? "",
    status: t.status,
    priority: t.priority ?? null,
    source: t.source ?? null,
    product: (t.custom_fields?.cf_product as string | undefined) ?? null,
    type: t.type ?? null,
    tags: t.tags ?? [],
    requesterId: t.requester_id ?? null,
    responderId: t.responder_id ?? null,
    groupId: t.group_id ?? null,
    companyId: t.company_id ?? null,
    toEmails: t.to_emails ?? null,
    spam: t.spam ?? false,
    customFields: t.custom_fields ?? null,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

const TICKET_COLS = [
  "subject", "status", "priority", "source", "product", "type", "tags", "requesterId",
  "responderId", "groupId", "companyId", "toEmails", "spam", "customFields", "createdAt", "updatedAt",
];

const MESSAGE_COLS = [
  "incoming", "private", "source", "userId", "fromEmail", "toEmails", "ccEmails",
  "bodyHtml", "bodyText", "bodyClean", "inlineImages", "createdAt", "updatedAt", "idx",
];

type MessageRow = typeof messages.$inferInsert;
type AttachmentRow = typeof attachments.$inferInsert;

function openingMessage(t: FDTicket): { msg: MessageRow; files: AttachmentRow[] } {
  const msgId = -t.id;
  const text = t.description_text ?? stripHtml(t.description ?? "");
  return {
    msg: {
      id: msgId,
      ticketId: t.id,
      idx: 0,
      // Outbound tickets (source 10) open with OUR message, not the customer's.
      incoming: t.source !== 10,
      private: false,
      source: null,
      userId: null,
      fromEmail: t.requester?.email ?? null,
      toEmails: t.to_emails ?? null,
      ccEmails: t.cc_emails ?? null,
      bodyHtml: t.description ?? null,
      bodyText: text,
      // The opening message is kept whole: a forwarded email's "quote" IS the content.
      bodyClean: text.replace(/\r\n?/g, "\n").trim(),
      inlineImages: countInlineImages(t.description ?? ""),
      createdAt: t.created_at,
      updatedAt: null,
    },
    files: (t.attachments ?? []).map((a) => attachmentRow(a, t.id, msgId)),
  };
}

function conversationRow(c: FDConversation, ticketId: number, idx: number): MessageRow {
  const text = c.body_text ?? stripHtml(c.body ?? "");
  return {
    id: c.id,
    ticketId,
    idx,
    incoming: c.incoming,
    private: c.private,
    source: c.source ?? null,
    userId: c.user_id ?? null,
    fromEmail: c.from_email ?? null,
    toEmails: c.to_emails ?? null,
    ccEmails: c.cc_emails ?? null,
    bodyHtml: c.body ?? null,
    bodyText: text,
    bodyClean: cleanEmailText(text),
    inlineImages: c.incoming ? countInlineImages(c.body ?? "") : 0,
    createdAt: c.created_at,
    updatedAt: c.updated_at ?? null,
  };
}

function attachmentRow(a: FDAttachment, ticketId: number, messageId: number): AttachmentRow {
  return {
    id: a.id,
    ticketId,
    messageId,
    name: a.name,
    contentType: a.content_type ?? null,
    size: a.size ?? null,
  };
}

async function upsertMessages(db: Db, rows: MessageRow[], files: AttachmentRow[]): Promise<void> {
  // Neon's HTTP driver has a request-size ceiling; long threads go in slices.
  for (let i = 0; i < rows.length; i += 25) {
    await db
      .insert(messages)
      .values(rows.slice(i, i + 25))
      .onConflictDoUpdate({ target: messages.id, set: excluded(MESSAGE_COLS) });
  }
  for (let i = 0; i < files.length; i += 100) {
    await db.insert(attachments).values(files.slice(i, i + 100)).onConflictDoNothing();
  }
}

/** Recompute the derived columns from the messages we now hold. */
async function refreshDerived(db: Db, ticketId: number): Promise<void> {
  await db.execute(sql`
    UPDATE tickets t SET
      message_count    = d.n,
      last_customer_at = d.last_customer,
      last_agent_at    = d.last_agent,
      last_public_from = d.last_from,
      synced_at        = now()
    FROM (
      SELECT
        count(*)::int AS n,
        max(created_at) FILTER (WHERE incoming AND NOT private) AS last_customer,
        max(created_at) FILTER (WHERE NOT incoming AND NOT private) AS last_agent,
        (SELECT CASE WHEN incoming THEN 'customer' ELSE 'agent' END
           FROM messages WHERE ticket_id = ${ticketId} AND NOT private
           ORDER BY created_at DESC, idx DESC LIMIT 1) AS last_from
      FROM messages WHERE ticket_id = ${ticketId}
    ) d
    WHERE t.id = ${ticketId}`);
}

// ── One ticket ──────────────────────────────────────────────────────

export type SyncResult = "skipped" | "synced" | "budget";

/**
 * Bring one ticket up to date. `listed` (from a list call) saves the ticket
 * fetch when we already hold the opening message.
 */
export async function syncTicket(
  ticketId: number,
  listed?: FDListTicket,
  opts: { force?: boolean; deadline?: number } = {},
): Promise<SyncResult> {
  const headroom = () => waitForHeadroom(RESERVE, maxWait(opts.deadline));
  const db = getDb();
  if (!db) return "skipped";

  const [have] = await db
    .select({ updatedAt: tickets.updatedAt, messageCount: tickets.messageCount })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);

  // Unchanged since our last sync: nothing to fetch.
  if (
    !opts.force &&
    have &&
    listed &&
    Date.parse(have.updatedAt) >= Date.parse(listed.updated_at) &&
    have.messageCount > 0
  ) {
    return "skipped";
  }

  if (!(await headroom())) return "budget";

  // New to us (or forced): the full ticket carries the opening message.
  let base: FDListTicket;
  if (!have || opts.force || !listed) {
    const full = await fd<FDTicket>(`/tickets/${ticketId}`);
    if (listed?.requester) full.requester = listed.requester;
    base = full;
    await db
      .insert(tickets)
      .values(ticketRow(full))
      .onConflictDoUpdate({ target: tickets.id, set: excluded(TICKET_COLS) });
    const { msg, files } = openingMessage(full);
    await upsertMessages(db, [msg], files);
  } else {
    base = listed;
    await db
      .insert(tickets)
      .values(ticketRow(listed))
      .onConflictDoUpdate({ target: tickets.id, set: excluded(TICKET_COLS) });
  }
  if (base.requester?.id) await upsertContact(db, base.requester);

  // Conversations are append-only in practice, so start at the page holding
  // the first one we don't have. A forced sync re-reads the whole thread.
  const known = opts.force || !have ? 0 : Math.max(0, have.messageCount - 1);
  let page = Math.floor(known / CONV_PAGE) + 1;
  for (; page <= 10; page++) {
    if (page > 1 && !(await headroom())) break;
    const batch = await fd<FDConversation[]>(
      `/tickets/${ticketId}/conversations?per_page=${CONV_PAGE}&page=${page}`,
    );
    const rows = batch.map((c, i) => conversationRow(c, ticketId, (page - 1) * CONV_PAGE + i + 1));
    const files = batch.flatMap((c) => (c.attachments ?? []).map((a) => attachmentRow(a, ticketId, c.id)));
    if (rows.length) await upsertMessages(db, rows, files);
    if (batch.length < CONV_PAGE) break;
  }

  await refreshDerived(db, ticketId);
  return "synced";
}

async function upsertContact(db: Db, c: { id: number; name?: string; email?: string }) {
  await db
    .insert(contacts)
    .values({ id: c.id, name: c.name ?? null, email: c.email ?? null })
    .onConflictDoUpdate({
      target: contacts.id,
      set: { name: sql`excluded.name`, email: sql`excluded.email`, syncedAt: sql`now()` },
    });
}

/** Agents change rarely; refreshed when the table is empty or a day old. */
export async function syncAgentsIfStale(): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const [row] = await db
    .select({ at: sql<string>`max(${agents.syncedAt})` })
    .from(agents);
  if (row?.at && Date.now() - Date.parse(row.at) < 86_400_000) return false;
  if (!(await waitForHeadroom(RESERVE))) return false;
  type FDAgent = { id: number; contact?: { name?: string; email?: string } };
  const list = await fd<FDAgent[]>(`/agents?per_page=100`);
  if (!list.length) return false;
  await db
    .insert(agents)
    .values(list.map((a) => ({ id: a.id, name: a.contact?.name ?? null, email: a.contact?.email ?? null })))
    .onConflictDoUpdate({
      target: agents.id,
      set: { name: sql`excluded.name`, email: sql`excluded.email`, syncedAt: sql`now()` },
    });
  return true;
}

// ── Walks ───────────────────────────────────────────────────────────

export interface WalkReport {
  cursor: string;
  listed: number;
  synced: number;
  skipped: number;
  stoppedFor?: "deadline" | "budget";
  done: boolean;
}

/**
 * Walk tickets updated since `cursor`, oldest first, until caught up or out of
 * time/budget. Returns the cursor to resume from: the updated_at of the last
 * ticket fully processed, so an interrupted page is simply walked again.
 */
async function walk(cursor: string, deadline: number): Promise<WalkReport> {
  const report: WalkReport = { cursor, listed: 0, synced: 0, skipped: 0, done: false };
  for (let page = 1; page <= 300; page++) {
    if (Date.now() > deadline) return { ...report, stoppedFor: "deadline" };
    if (!(await waitForHeadroom(RESERVE, maxWait(deadline)))) return { ...report, stoppedFor: "budget" };
    const since = encodeURIComponent(cursor);
    const batch = await fd<FDListTicket[]>(
      `/tickets?updated_since=${since}&order_by=updated_at&order_type=asc&per_page=${LIST_PAGE}&page=${page}&include=requester`,
    );
    report.listed += batch.length;
    for (const t of batch) {
      if (Date.now() > deadline) return { ...report, stoppedFor: "deadline" };
      const r = await syncTicket(t.id, t, { deadline });
      if (r === "budget") return { ...report, stoppedFor: "budget" };
      if (r === "synced") report.synced++;
      else report.skipped++;
      report.cursor = t.updated_at;
    }
    if (batch.length < LIST_PAGE) return { ...report, done: true };
  }
  return report;
}

interface BackfillState {
  cursor: string;
  done: boolean;
  startedAt: string;
}

export interface SyncRunReport {
  delta: WalkReport;
  backfill?: WalkReport;
  agents: boolean;
}

/** One cron tick: catch up on changes, then spend what's left on history. */
export async function runTicketSync(budgetMs: number): Promise<SyncRunReport | null> {
  const db = getDb();
  if (!db) return null;
  const deadline = Date.now() + budgetMs;

  // First run: start the delta from now; history is the backfill's job.
  const deltaCursor =
    (await getState<string>(db, "delta_cursor")) ?? new Date(Date.now() - 5 * 60_000).toISOString();
  const walkStarted = new Date(Date.now() - 60_000).toISOString();
  const delta = await walk(deltaCursor, deadline);
  await setState(db, "delta_cursor", delta.cursor);
  // A finished walk means every ticket changed before it started is mirrored —
  // the freshness readers rely on (lib/ticket-mirror/read.ts), even in a quiet
  // hour when the cursor itself doesn't move.
  if (delta.done) await setState(db, "delta_caught_up_at", walkStarted);

  const agentsSynced = await syncAgentsIfStale().catch(() => false);

  let backfill: WalkReport | undefined;
  const bf =
    (await getState<BackfillState>(db, "backfill")) ??
    ({
      cursor: new Date(Date.now() - BACKFILL_DAYS * 86_400_000).toISOString(),
      done: false,
      startedAt: new Date().toISOString(),
    } satisfies BackfillState);
  if (!bf.done && delta.done && Date.now() < deadline) {
    backfill = await walk(bf.cursor, deadline);
    // The backfill is finished once it has walked up to where the delta began.
    const caughtUp = backfill.done || Date.parse(backfill.cursor) >= Date.parse(deltaCursor);
    await setState(db, "backfill", { ...bf, cursor: backfill.cursor, done: caughtUp });
  }

  if (delta.synced || backfill?.synced) await bumpDataVersion("tickets");
  return { delta, backfill, agents: agentsSynced };
}

/** Mirror coverage, for /system and the console. */
export async function mirrorStatus(): Promise<{
  tickets: number;
  messages: number;
  deltaCursor: string | null;
  backfill: BackfillState | null;
} | null> {
  const db = getDb();
  if (!db) return null;
  const [t] = await db.select({ n: sql<number>`count(*)::int` }).from(tickets);
  const [m] = await db.select({ n: sql<number>`count(*)::int` }).from(messages);
  return {
    tickets: t?.n ?? 0,
    messages: m?.n ?? 0,
    deltaCursor: await getState<string>(db, "delta_cursor"),
    backfill: await getState<BackfillState>(db, "backfill"),
  };
}
