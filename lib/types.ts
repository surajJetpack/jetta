/** Shared domain types for Jetta. */

export type Product = "jetpackapps" | "getsign" | "unknown";

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
  status: string;
  url: string;
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

/** One turn in a JettaChat conversation. */
export interface ChatMessage {
  id: string;
  /** "visitor" is the customer; "agent" is Jetta (or a human replying later). */
  author: "visitor" | "agent";
  text: string;
  createdAt: string;
}

/**
 * Identity the embedding page handed us. On monday this comes from the app
 * SDK and is trustworthy enough to drive account lookups; on WordPress it is
 * whatever the visitor typed, so treat it as a hint only.
 */
export interface ChatVisitor {
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
  status: "open" | "resolved" | "ticketed";
  surface: ChatSurface;
  /** Page the widget was opened on — useful context and abuse triage. */
  pageUrl?: string;
  visitor: ChatVisitor;
  messages: ChatMessage[];
  /** Freshdesk ticket opened as the escalation path, once one exists. */
  ticketId?: string;
}

/** Assembled context handed to the Claude loop for a single turn. */
export interface ConversationContext {
  channel: Channel;
  ticket: Ticket | null;
  account: FastSpringAccount | null;
  relatedDevItems: DevBoardItem[];
  product: Product;
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
  };
}

/** Token usage of one LLM task, for the per-ticket cost breakdown. */
export interface TaskUsage {
  task: "triage" | "rerank" | "agent";
  model: string;
  inputTokens: number;
  outputTokens: number;
}
