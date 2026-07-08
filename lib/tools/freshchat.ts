/**
 * Freshchat tool client — live-chat conversations adapted into the `Ticket`
 * shape so the whole agent pipeline (context → messages → tools) works
 * unchanged on the chat channel.
 *
 * Every function honours STUB_MODE / FRESHCHAT_LIVE: without credentials it
 * returns realistic canned data (including a Freddy bot hand-off turn) so the
 * chat path can be exercised end-to-end before any live credential exists.
 *
 * API notes (Conversations API v2, Bearer auth):
 *   GET  /conversations/{id}            — status + assignment
 *   GET  /conversations/{id}/messages   — paginated, newest first
 *   POST /conversations/{id}/messages   — send a message as an agent actor
 *   PUT  /conversations/{id}            — status changes (resolve)
 *   GET  /users/{id}                    — requester name/email (may be absent
 *                                         for anonymous web visitors)
 * Field shapes below are from the docs; they are verified against real traffic
 * during rollout (scripts/fc-read.ts) before anything goes live.
 */
import { config } from "../config";
import type { Ticket, TicketReply } from "../types";

function fcHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${config.freshchat.apiToken}`,
    "Content-Type": "application/json",
  };
}

async function fc<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${config.freshchat.apiUrl}${path}`, {
    ...init,
    headers: fcHeaders(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Freshchat ${init?.method ?? "GET"} ${path} failed: ${res.status} ${body}`);
  }
  return (await res.json()) as T;
}

// ── API shapes (docs-derived; verify via scripts/fc-read.ts before go-live) ──

interface FcMessagePart {
  text?: { content: string };
  // image / file / collection parts exist; we surface them as placeholders.
  [key: string]: unknown;
}

interface FcMessage {
  id: string;
  conversation_id: string;
  actor_type: "user" | "agent" | "system" | string;
  actor_id: string;
  message_type?: "normal" | "private" | string;
  message_parts?: FcMessagePart[];
  created_time: string;
}

interface FcConversation {
  conversation_id: string;
  status?: string;
  assigned_agent_id?: string;
  assigned_group_id?: string;
  users?: { id: string }[];
}

interface FcMessagesPage {
  messages?: FcMessage[];
  // Pagination shape varies across accounts (`link.rel=next` vs `pagination`);
  // we follow `link.href` when present.
  link?: { rel?: string; href?: string };
}

interface FcUser {
  id: string;
  first_name?: string;
  last_name?: string;
  email?: string;
}

/** Cap on messages fetched per conversation (chat threads can be long). */
const MAX_MESSAGES = 200;

function partText(m: FcMessage): string {
  const parts = m.message_parts ?? [];
  const texts = parts.map((p) =>
    p.text?.content != null ? p.text.content : "[attachment]",
  );
  return texts.join("\n").trim();
}

/** Chat status → the Ticket status vocabulary the prompt/rules already use. */
function mapStatus(status?: string): string {
  if (!status) return "open";
  if (["new", "assigned", "reopened"].includes(status)) return "open";
  return status; // "resolved" passes through
}

/**
 * Fetch every message in the conversation, oldest first. Handles the
 * newest-first paginated API and caps at MAX_MESSAGES.
 */
async function listMessages(conversationId: string): Promise<FcMessage[]> {
  const all: FcMessage[] = [];
  let path: string | null = `/conversations/${conversationId}/messages?items_per_page=50`;
  while (path && all.length < MAX_MESSAGES) {
    const page: FcMessagesPage = await fc<FcMessagesPage>(path);
    all.push(...(page.messages ?? []));
    const next = page.link?.rel === "next" ? page.link.href : null;
    // The API returns either an absolute href or a path; normalize to a path.
    path = next ? next.replace(config.freshchat.apiUrl, "") : null;
  }
  return all
    .slice(0, MAX_MESSAGES)
    .sort((a, b) => Date.parse(a.created_time) - Date.parse(b.created_time));
}

const STUB_CONVERSATION: Omit<Ticket, "id"> = {
  subject: "[Chat] Signed documents aren't landing in our board's file column",
  description:
    "Hi, we send contracts with GetSign but the signed PDFs aren't showing up in the Files column on our board. Where do they go?",
  status: "open",
  requesterName: "Sam Rivera",
  requesterEmail: "sam@example.com",
  replies: [
    {
      author: "agent",
      authorEmail: null,
      body: "I couldn't find an answer for that — connecting you with the team now. One moment!",
      createdAt: "2026-01-01T10:00:30Z",
      isPrivate: false,
    },
  ],
};

/**
 * Adapt a Freshchat conversation into the `Ticket` shape:
 * - subject   = first customer message, one line, truncated, prefixed [Chat]
 * - description = full first customer message
 * - replies   = every later message (bot/human/Jetta turns → "agent")
 */
export async function getConversationAsTicket(conversationId: string): Promise<Ticket> {
  if (!config.freshchat.live) {
    return { id: conversationId, ...STUB_CONVERSATION };
  }

  const [conv, messages] = await Promise.all([
    fc<FcConversation>(`/conversations/${conversationId}`),
    listMessages(conversationId),
  ]);

  // Requester: the first (usually only) user actor on the conversation.
  let requesterName: string | null = null;
  let requesterEmail: string | null = null;
  const userId = conv.users?.[0]?.id ?? messages.find((m) => m.actor_type === "user")?.actor_id;
  if (userId) {
    try {
      const user = await fc<FcUser>(`/users/${userId}`);
      requesterName = [user.first_name, user.last_name].filter(Boolean).join(" ") || null;
      requesterEmail = user.email ?? null; // absent for anonymous visitors
    } catch {
      // Best-effort, like the Freshdesk contact lookup.
    }
  }

  const firstUserIdx = messages.findIndex((m) => m.actor_type === "user");
  const opening = firstUserIdx >= 0 ? partText(messages[firstUserIdx]) : "";
  const openingLine = opening.split("\n")[0] ?? "";
  const subject = `[Chat] ${openingLine.slice(0, 80)}${openingLine.length > 80 ? "…" : ""}`;

  const replies: TicketReply[] = messages
    .filter((_, i) => i !== firstUserIdx)
    .map((m) => ({
      author: m.actor_type === "user" ? ("customer" as const) : ("agent" as const),
      authorEmail: m.actor_type === "user" ? requesterEmail : null,
      body: partText(m),
      createdAt: m.created_time,
      isPrivate: m.message_type === "private",
    }))
    .filter((r) => r.body.length > 0);

  return {
    id: conversationId,
    subject,
    description: opening || "(no message text)",
    status: mapStatus(conv.status),
    requesterName,
    requesterEmail,
    replies,
  };
}

/**
 * Chat message parts render as plain text — flatten the light markdown the
 * model produces for tickets into something readable in the widget.
 */
export function toChatText(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+/gm, "") // headings
    .replace(/\*\*([^*]+)\*\*/g, "$1") // bold
    .replace(/(?<!\w)[_*]([^_*]+)[_*](?!\w)/g, "$1") // emphasis
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1: $2") // links → "title: url"
    .replace(/^\s*[-*]\s+/gm, "• ") // bullets
    .trim();
}

/** Send a customer-visible chat message as the Jetta agent actor. */
export async function replyToConversation(conversationId: string, body: string): Promise<void> {
  if (!config.freshchat.live) {
    console.log(`[stub] reply_to_conversation ${conversationId}:\n${toChatText(body)}`);
    return;
  }
  const agentId = config.freshchat.agentId;
  if (!agentId) throw new Error("FRESHCHAT_AGENT_ID is required to send chat messages.");
  await fc(`/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      actor_type: "agent",
      actor_id: agentId,
      message_type: "normal",
      message_parts: [{ text: { content: toChatText(body) } }],
    }),
  });
}

/** Mark the conversation resolved. */
export async function resolveConversation(conversationId: string): Promise<void> {
  if (!config.freshchat.live) {
    console.log(`[stub] resolve_conversation ${conversationId}`);
    return;
  }
  await fc(`/conversations/${conversationId}`, {
    method: "PUT",
    body: JSON.stringify({ status: "resolved" }),
  });
}

/**
 * Is this conversation assigned to Jetta (her agent id or the hand-off group)?
 * The authoritative gate for acting on webhook events — payloads don't reliably
 * carry assignment, so we re-fetch.
 */
export async function isAssignedToJetta(conversationId: string): Promise<boolean> {
  if (!config.freshchat.live) return true;
  const conv = await fc<FcConversation>(`/conversations/${conversationId}`);
  const { agentId, handoffGroupId } = config.freshchat;
  return (
    (!!agentId && conv.assigned_agent_id === agentId) ||
    (!!handoffGroupId && conv.assigned_group_id === handoffGroupId)
  );
}

/**
 * Newest customer message id — the webhook's debounce check: if a newer user
 * message arrived while we slept, this delivery is superseded and exits.
 * Stub returns the queried id so debounce always passes in stub mode (the
 * debounce logic itself is verified live during rollout).
 */
export async function getLatestUserMessageId(
  conversationId: string,
  fallbackId?: string,
): Promise<string | null> {
  if (!config.freshchat.live) return fallbackId ?? null;
  const page = await fc<FcMessagesPage>(
    `/conversations/${conversationId}/messages?items_per_page=20`,
  );
  const newest = (page.messages ?? [])
    .filter((m) => m.actor_type === "user")
    .sort((a, b) => Date.parse(b.created_time) - Date.parse(a.created_time))[0];
  return newest?.id ?? null;
}

/** Deep link to the conversation in the Freshchat agent console (for escalations). */
export function conversationUrl(conversationId: string): string {
  return config.freshchat.webUrl
    ? `${config.freshchat.webUrl}/conversations/${conversationId}`
    : `(freshchat conversation ${conversationId})`;
}
