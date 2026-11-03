/**
 * Postgres schema for Jetta's own copy of the help desk.
 *
 * Phase 1 of Option C (see docs/changelog.md, 2026-11-03): every Freshdesk
 * ticket and message is mirrored here so Jetta and the console read from our
 * database instead of the Freshdesk API (40 calls/min, shared by everything).
 * Freshdesk stays the system of record for writes until the email pipe moves.
 *
 * Ids are Freshdesk's own, so a row is always traceable back to FD. The one
 * exception is a ticket's opening message, which FD stores on the ticket rather
 * than as a conversation: it lives in `messages` with id = -ticketId, idx 0.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const tsvector = customType<{ data: string }>({
  dataType: () => "tsvector",
});

const id = (name: string) => bigint(name, { mode: "number" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

export const tickets = pgTable(
  "tickets",
  {
    id: id("id").primaryKey(),
    subject: text("subject").notNull().default(""),
    /** Freshdesk numeric status (2 open, 3 pending, 4 resolved, 5 closed, 6-12 custom). */
    status: integer("status").notNull(),
    priority: integer("priority"),
    /** 1 email, 2 portal, 3 in-app form, 7 chat, 9 feedback widget, 10 outbound. */
    source: integer("source"),
    /** `cf_product` — which app the ticket is about. */
    product: text("product"),
    type: text("type"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    requesterId: id("requester_id"),
    responderId: id("responder_id"),
    groupId: id("group_id"),
    companyId: id("company_id"),
    toEmails: text("to_emails").array(),
    spam: boolean("spam").notNull().default(false),
    deleted: boolean("deleted").notNull().default(false),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
    /** Derived from `messages` after every sync. */
    messageCount: integer("message_count").notNull().default(0),
    lastCustomerAt: ts("last_customer_at"),
    lastAgentAt: ts("last_agent_at"),
    /** Who wrote the newest public message: "customer" | "agent". Drives "needs reply". */
    lastPublicFrom: text("last_public_from"),
    customFields: jsonb("custom_fields"),
    syncedAt: ts("synced_at").notNull().defaultNow(),
    search: tsvector("search").generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(subject, ''))`,
    ),
  },
  (t) => [
    index("tickets_updated_idx").on(t.updatedAt),
    index("tickets_status_idx").on(t.status),
    index("tickets_requester_idx").on(t.requesterId),
    index("tickets_search_idx").using("gin", t.search),
  ],
);

export const messages = pgTable(
  "messages",
  {
    /** FD conversation id; -ticketId for the opening message. */
    id: id("id").primaryKey(),
    ticketId: id("ticket_id").notNull(),
    /** Position in the thread: 0 is the opening message. Stable — new replies append. */
    idx: integer("idx").notNull(),
    incoming: boolean("incoming").notNull(),
    private: boolean("private").notNull().default(false),
    /** FD conversation source: 0 reply, 2 note, 5 tweet... null for the opening message. */
    source: integer("source"),
    /** FD agent who wrote it (identifies Jetta's own sends). */
    userId: id("user_id"),
    fromEmail: text("from_email"),
    toEmails: text("to_emails").array(),
    ccEmails: text("cc_emails").array(),
    /** Raw HTML — the only record of images pasted into the body. */
    bodyHtml: text("body_html"),
    bodyText: text("body_text"),
    /** Body without the quoted email history underneath. What readers should use. */
    bodyClean: text("body_clean"),
    inlineImages: integer("inline_images").notNull().default(0),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at"),
    search: tsvector("search").generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(body_clean, ''))`,
    ),
  },
  (t) => [
    index("messages_ticket_idx").on(t.ticketId, t.idx),
    index("messages_search_idx").using("gin", t.search),
  ],
);

/** Metadata only: FD attachment URLs are pre-signed and expire in minutes. */
export const attachments = pgTable(
  "attachments",
  {
    id: id("id").primaryKey(),
    ticketId: id("ticket_id").notNull(),
    messageId: id("message_id").notNull(),
    name: text("name").notNull(),
    contentType: text("content_type"),
    size: integer("size"),
  },
  (t) => [index("attachments_ticket_idx").on(t.ticketId)],
);

export const contacts = pgTable(
  "contacts",
  {
    id: id("id").primaryKey(),
    name: text("name"),
    email: text("email"),
    companyId: id("company_id"),
    syncedAt: ts("synced_at").notNull().defaultNow(),
  },
  (t) => [index("contacts_email_idx").on(t.email)],
);

export const agents = pgTable("agents", {
  id: id("id").primaryKey(),
  name: text("name"),
  email: text("email"),
  syncedAt: ts("synced_at").notNull().defaultNow(),
});

/** Rolling summary of a long thread's older messages (messages 0..uptoIdx). */
export const threadSummaries = pgTable(
  "thread_summaries",
  {
    ticketId: id("ticket_id").notNull(),
    uptoIdx: integer("upto_idx").notNull(),
    summary: text("summary").notNull(),
    model: text("model"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.ticketId, t.uptoIdx] })],
);

/** Cursors and small bits of sync bookkeeping. */
export const syncState = pgTable("sync_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
