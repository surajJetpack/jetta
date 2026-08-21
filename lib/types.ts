/** Shared domain types for Jetta. */

export type Product = "jetpackapps" | "getsign" | "unknown";

/**
 * Where a `Product` attribution came from, and therefore how much weight it
 * can carry. "ground-truth" is Freshdesk's cf_product field or the embedding
 * page naming its own app; "inferred" is the keyword heuristic or LLM triage.
 *
 * Only ground truth may NARROW anything (see lib/profiles.ts): a guess that
 * turns out wrong should cost a customer the right branding, never the article
 * that answers their question.
 */
export type ProductSource = "ground-truth" | "inferred";

/**
 * The specific monday.com app a ticket concerns — finer-grained than `Product`.
 * Each app bills through its own separate FastSpring store, so billing lookups
 * need to know which app, not just the "jetpackapps" vs "getsign" bucket.
 */
/**
 * Display names for the apps. Lives with the type so server digests and the
 * console render an app the same way — "vlookup" should never reach a human.
 */
export const APP_NAMES: Record<string, string> = {
  getsign: "GetSign",
  vlookup: "VLOOKUP Auto-Link",
  trackmy: "TrackMy",
  extract: "Extract AI",
  jobflows: "JobFlows",
  smartcolumns: "Smart Columns",
  jetscan: "JetScan HR",
  pivotreports: "Pivot Reports Pro",
  triggerly: "Triggerly",
  unknown: "Unattributed",
};

/** Human-readable app name, falling back to the raw key. */
export function appName(app: string | null | undefined): string {
  return APP_NAMES[app ?? "unknown"] ?? app ?? "Unattributed";
}

export type AppProduct =
  | "vlookup"
  | "trackmy"
  | "extract"
  | "jobflows"
  | "smartcolumns"
  | "jetscan"
  | "pivotreports"
  | "triggerly"
  | "getsign"
  | "unknown";

/**
 * A file attached to a ticket. `url` is Freshdesk's pre-signed S3 link, which
 * expires within minutes — re-resolve it before downloading rather than holding
 * onto one captured earlier in the run.
 */
export interface Attachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  url: string;
  /** Who attached it — customer-sent files are the ones devs need. */
  author: "agent" | "customer";
}

/** An attachment's downloaded bytes, ready to forward into another system. */
export interface AttachmentFile {
  name: string;
  contentType: string;
  data: ArrayBuffer;
}

/** A single message in a Freshdesk ticket conversation. */
export interface TicketReply {
  /** "agent" (Jetta or a human) or "customer". */
  author: "agent" | "customer";
  authorEmail: string | null;
  body: string;
  createdAt: string;
  /** Internal agent-only notes are never shown to the requester. */
  isPrivate: boolean;
}

export interface Ticket {
  id: string;
  subject: string;
  description: string;
  status: string;
  requesterName: string | null;
  requesterEmail: string | null;
  replies: TicketReply[];
  /** Freshdesk cf_product custom field — ground truth for product attribution. */
  productHint?: string | null;
  /** Files attached across the description and every reply, oldest first. */
  attachments?: Attachment[];
}

export interface FastSpringInvoice {
  id: string;
  date: string;
  amount: string;
  url: string | null;
}

export interface FastSpringAccount {
  found: boolean;
  email: string;
  accountId: string | null;
  /** The subscription to act on (discount/cancel target). Active one preferred. */
  subscriptionId: string | null;
  planName: string | null;
  /** Recurring charge amount, formatted (e.g. "$45.00"). */
  planPrice: string | null;
  billingCycle: string | null;
  nextChargeDate: string | null;
  /** Human-readable payment method, e.g. "Mastercard ····5937" or "PayPal". */
  paymentMethod: string | null;
  /**
   * Proxy for "worth offering a retention discount": the account has an ACTIVE
   * (not deactivated/canceled) subscription. FastSpring exposes no true product
   * usage signal, so subscription state is the best available proxy.
   */
  activeLast30Days: boolean;
  invoices: FastSpringInvoice[];
}

export interface DevBoardItem {
  id: string;
  title: string;
  /** The board's own progress value ("Working on it", "ToDo"), or "unknown". */
  status: string;
  url: string;
  /** Who has it, from the board's Developer column. Absent when nobody does. */
  assignee?: string;
  priority?: string;
  /** The board's "Last Updated" stamp, as monday renders it. */
  updatedAt?: string;
}

/** Where the current interaction originated. */
export type Channel = "freshdesk" | "freshchat" | "slack" | "jettachat";

/**
 * Channels the agent pipeline can actually run a turn on — `Channel` minus
 * "slack", which is a notification target rather than a conversation Jetta
 * holds. Used for the ticket-fetch and reply dispatch.
 */
export type RunChannel = "freshdesk" | "freshchat" | "jettachat";

/** Surface a JettaChat widget session was opened from. */
export type ChatSurface = "wordpress" | "monday" | "unknown";

/**
 * A file a visitor sent in a chat.
 *
 * `pathname` is a private blob key, never a URL — reads go through
 * /api/chat/file so the conversation token or a console session is checked
 * every time. `description` is what the vision pass saw, and it is stored
 * rather than recomputed so the record of what Jetta was told she saw survives
 * a model change.
 */
export interface ChatAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  pathname: string;
  width?: number;
  height?: number;
  description?: string;
}

/** One turn in a JettaChat conversation. */
export interface ChatMessage {
  id: string;
  /** "visitor" is the customer; "agent" is our side of the conversation. */
  author: "visitor" | "agent";
  /**
   * Which of us wrote it. Absent on messages written before handoff existed,
   * which were all Jetta — so undefined reads as "jetta" everywhere.
   *
   * The visitor is told: being handed to a person and not knowing it happened
   * is worse than not being handed over at all, and a reviewer reading a
   * transcript cannot judge Jetta's answers without knowing which were hers.
   */
  via?: "jetta" | "human";
  /** Display name for a human's message — the console user who sent it. */
  authorName?: string;
  /** A system line ("X joined the chat") rather than something someone typed. */
  system?: boolean;
  text: string;
  /** Files sent with this message. Visitor-side only today. */
  attachments?: ChatAttachment[];
  createdAt: string;
}

/**
 * Identity the embedding page handed us. On monday this comes from the app
 * SDK and is trustworthy enough to drive account lookups; on WordPress it is
 * whatever the visitor typed, so treat it as a hint only.
 */
export interface ChatVisitor {
  /** Required to start a chat — see the pre-chat gate in the session route. */
  name?: string;
  email?: string;
  /** monday account slug, when the widget runs inside a monday app view. */
  mondayAccountSlug?: string;
  mondayAccountId?: string;
  mondayUserId?: string;
  /** Which app the view is embedded in — a direct AppProduct signal. */
  app?: AppProduct;
}

/** A JettaChat conversation, stored in Redis and adapted into `Ticket`. */
export interface ChatConversation {
  id: string;
  createdAt: string;
  lastActivityAt: string;
  /**
   * open          — Jetta is answering
   * waiting_human — a person has been asked for; Jetta is silent, a timer will
   *                 fall back to a ticket if nobody arrives
   * human         — a person is in the conversation; Jetta stays silent
   * resolved      — done
   * ticketed      — a Freshdesk ticket carries the outcome, and the team will
   *                 reply there by email. NOT an end state for the chat: Jetta
   *                 keeps answering, and anything new the visitor says is
   *                 pushed onto the ticket via add_to_ticket. The status says
   *                 where the ANSWER will come from, not whether the
   *                 conversation is over.
   */
  status: "open" | "waiting_human" | "human" | "resolved" | "ticketed";
  /** Unix ms a human was requested — drives the "nobody came" fallback. */
  humanRequestedAt?: number;
  /** Console username of whoever took the conversation. */
  humanAgent?: string;
  surface: ChatSurface;
  /** Page the widget was opened on — useful context and abuse triage. */
  pageUrl?: string;
  visitor: ChatVisitor;
  messages: ChatMessage[];
  /**
   * The ACTIVE Freshdesk ticket — the one add_to_ticket writes to and the one
   * the console links. Singular on purpose: the console, /today's dedupe and
   * the guide all read this field, and one conversation has one live thread at
   * a time even when it has raised more than one issue.
   */
  ticketId?: string;
  /**
   * Tickets this conversation opened earlier, oldest first.
   *
   * A chat can raise two genuinely separate problems — support widgets invite
   * exactly that, because someone already typing will bundle questions — and
   * merging them into one ticket gives the team a thread they cannot close.
   * When a second issue gets its own ticket, the first moves here.
   *
   * The known limitation: if the customer then goes BACK to the first issue,
   * updates land on the newest ticket. Rare enough to accept, and the private
   * note says it came from the live chat, so an agent can follow it across.
   */
  previousTicketIds?: string[];
  /** ISO time the ticket was opened. Stamped by the store on the transition. */
  ticketedAt?: string;
  /**
   * ISO high-water mark: everything said at or before this has already been
   * pushed onto the ticket. Advanced by add_to_ticket, so a second call sends
   * the delta rather than the transcript again.
   */
  lastTicketSyncAt?: string;
}

/** Assembled context handed to the Claude loop for a single turn. */
export interface ConversationContext {
  channel: Channel;
  ticket: Ticket | null;
  account: FastSpringAccount | null;
  relatedDevItems: DevBoardItem[];
  product: Product;
  /**
   * How `product` was determined. Drives brand-profile selection only — the
   * GetSign profile's narrowed KB scope needs a product we KNOW, not one we
   * guessed. Absent is treated as "inferred".
   */
  productSource?: ProductSource;
  /**
   * Which app's FastSpring store `account` (if any) was looked up against, and
   * which store a billing write would hit. Derived from cf_product/keywords
   * only — never from the LLM, so a misread can't move money in the wrong
   * store. Use `app` for reporting.
   */
  appProduct: AppProduct;
  /**
   * Best-known specific app, for attribution and reporting: cf_product >
   * keywords > triage. "jetpackapps" covers nine separate apps, so the coarse
   * `product` field can't answer "which app is having a bad week".
   */
  app?: AppProduct;
  /** Light-model triage rating; drives tiered model routing. Absent in stub mode. */
  complexity?: "simple" | "standard";
  /** Intake classification — non-"customer_query" tickets are skipped (no draft). */
  intake?: "customer_query" | "auto_reply" | "marketing" | "spam" | "other";
  /** Short triage-written theme ("signing link expired"); powers topic trends. */
  topic?: string;
  /** Token usage of auxiliary LLM calls made for this ticket (triage, rerank). */
  taskUsage?: TaskUsage[];
  /**
   * JettaChat only — identity the embedding page supplied. Worth carrying
   * separately from `ticket` because the monday account slug is something no
   * other channel knows up front: on Freshdesk the trial/discount tools have
   * to ask the customer for their monday URL, and here we already have it.
   */
  chat?: {
    surface: ChatSurface;
    mondayAccountSlug?: string;
    pageUrl?: string;
    /**
     * Whether a person can actually be fetched into this conversation. Drives
     * BOTH the tool list and the prompt, so Jetta can never offer something
     * the console has switched off — or, as before, be told nobody is
     * listening while holding a tool that pings a channel someone watches.
     */
    handoffEnabled: boolean;
    /**
     * The Freshdesk ticket this conversation already has, if any. Its presence
     * is what swaps create_support_ticket for add_to_ticket and adds the
     * post-ticket rules to the prompt: one conversation, one thread.
     */
    ticketId?: string;
  };
}

/** Token usage of one LLM task, for the per-ticket cost breakdown. */
export interface TaskUsage {
  task: "triage" | "rerank" | "agent";
  model: string;
  inputTokens: number;
  outputTokens: number;
}
