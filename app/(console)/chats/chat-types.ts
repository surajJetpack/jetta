/**
 * The chat inbox's data shapes and the small pure rules every pane shares —
 * status vocabulary, the app-attribution fallback, the suggested ticket
 * subject. No React here, so any of the inbox's files can import it.
 */
import type { ChipTone } from "@/components/jetta/status-chip";

export interface Attachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  pathname: string;
  /** What the vision pass read out of the image, for our eyes only. */
  description?: string;
}
export interface Msg {
  id: string;
  author: "visitor" | "agent";
  via?: "jetta" | "human";
  authorName?: string;
  system?: boolean;
  text: string;
  attachments?: Attachment[];
  createdAt: string;
}

/**
 * Attachments are private blobs behind an authorization check. The console
 * hits the same route the widget does, but authenticates with its session
 * cookie instead of a conversation token — so no token in the URL here.
 */
/**
 * First thing the visitor TYPED, as a starting subject — not the first
 * message, since a chat that opens with a bare screenshot would otherwise be
 * titled with the vision pass's description of a dialog box. The server
 * applies the same rule when the field arrives empty.
 */
export function suggestSubject(c: Conv): string {
  const typed = c.messages.find((m) => m.author === "visitor" && m.text.trim())?.text ?? "";
  const line = typed.split("\n")[0]!.trim();
  if (!line) return "Support request from live chat";
  return line.length > 70 ? `${line.slice(0, 70)}…` : line;
}

export function consoleFileUrl(pathname: string): string {
  return `/api/chat/file/${pathname.replace(/^chat\//, "")}`;
}
export interface Conv {
  id: string;
  createdAt: string;
  lastActivityAt: string;
  status: "open" | "waiting_human" | "human" | "resolved" | "ticketed";
  surface: string;
  pageUrl?: string;
  humanAgent?: string;
  /** Who finished it — a console username, or "jetta" when she did. */
  resolvedBy?: string;
  ticketId?: string;
  /** Earlier tickets this conversation opened, oldest first. */
  previousTicketIds?: string[];
  /** Which app the conversation is about — the embed's pin, else triage's read. */
  app?: string;
  visitor: { name?: string; email?: string; mondayAccountSlug?: string; app?: string };
  /** Which brand skin the visitor saw — annotated server-side (lib/profiles). */
  brandKey?: "main" | "getsign";
  messages: Msg[];
}

export const TONES: Record<Conv["status"], ChipTone> = {
  waiting_human: "stale",
  human: "in_review",
  open: "published",
  ticketed: "draft",
  resolved: "archived",
};
export const LABELS: Record<Conv["status"], string> = {
  waiting_human: "wants a person",
  human: "with a person",
  open: "Jetta",
  ticketed: "ticketed",
  resolved: "resolved",
};

export type Filter = "needs_human" | "all" | "open" | "ticketed" | "resolved";

/** Sentinel for "every app" — Radix Select has no empty-string value. */
export const ALL_APPS = "__all__";
/** …and for the chats nothing has attributed yet, which are worth their own view. */
export const NO_APP = "unknown";

/**
 * Which app a conversation is about.
 *
 * `app` is stamped by the run (the embed's `data-app` if the snippet set one,
 * otherwise triage reading what they actually asked about); `visitor.app` is
 * the raw embed value and covers conversations that arrived before the stamp
 * existed. A chat with neither predates both and groups under "Other apps"
 * rather than being hidden, because a filter that silently drops rows is worse
 * than one that admits what it does not know.
 */
export function appOf(c: Conv): string {
  return c.app || c.visitor.app || NO_APP;
}

/** One entry in the app filter: the app, how many chats it has, its display name. */
export interface AppOption {
  value: string;
  count: number;
  label: string;
}
