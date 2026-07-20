/** Shared domain types for Jetta. */

export type Product = "jetpackapps" | "getsign" | "unknown";

/**
 * The specific monday.com app a ticket concerns — finer-grained than `Product`.
 * Each app bills through its own separate FastSpring store, so billing lookups
 * need to know which app, not just the "jetpackapps" vs "getsign" bucket.
 */
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
  planName: string | null;
  billingCycle: string | null;
  nextChargeDate: string | null;
  cardLastFour: string | null;
  /** Whether the account shows usage in the last 30 days (drives the churn flow). */
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
export type Channel = "freshdesk" | "freshchat" | "slack";

/** Assembled context handed to the Claude loop for a single turn. */
export interface ConversationContext {
  channel: Channel;
  ticket: Ticket | null;
  account: FastSpringAccount | null;
  relatedDevItems: DevBoardItem[];
  product: Product;
  /** Which app's FastSpring store `account` (if any) was looked up against. */
  appProduct: AppProduct;
  /** Light-model triage rating; drives tiered model routing. Absent in stub mode. */
  complexity?: "simple" | "standard";
  /** Token usage of auxiliary LLM calls made for this ticket (triage, rerank). */
  taskUsage?: TaskUsage[];
}

/** Token usage of one LLM task, for the per-ticket cost breakdown. */
export interface TaskUsage {
  task: "triage" | "rerank" | "agent";
  model: string;
  inputTokens: number;
  outputTokens: number;
}
