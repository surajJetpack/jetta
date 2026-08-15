/**
 * Turning a chat into a Freshdesk ticket.
 *
 * Two callers, one path: Jetta's `create_support_ticket` tool and the console's
 * convert button. They were written weeks apart and the temptation is to let
 * each build its own ticket body — which ends with a hand-off that carries the
 * screenshots when the bot does it and doesn't when a person does, discovered
 * by the agent who needed the screenshot.
 *
 * What a ticket from a chat carries:
 *   description  — the summary and the transcript. CUSTOMER-VISIBLE: Freshdesk
 *                  shows it in the portal and quotes it in the notification
 *                  email, so nothing internal goes here.
 *   attachments  — whatever the visitor sent, so nobody has to ask twice.
 *   private note — the link back to the conversation, and where it came from.
 */
import * as freshdesk from "./tools/freshdesk";
import * as chatFiles from "./chat-files";
import { transcriptText } from "./chat-store";
import { conversationUrl } from "./tools/jettachat";
import type { AppProduct, ChatConversation } from "./types";

export interface OpenTicketOptions {
  /** Requester address. Checked by the caller; used verbatim. */
  email: string;
  subject: string;
  /** The paragraph for whoever picks the ticket up. */
  summary: string;
  /** App slug for cf_product attribution, when known. */
  productHint?: AppProduct | string | null;
  /**
   * Who did this — a console username, or absent when Jetta did it herself.
   * Recorded in the private note because "why is there a ticket" is a
   * different question depending on the answer.
   */
  actor?: string;
}

export async function openTicketForConversation(
  conv: ChatConversation,
  opts: OpenTicketOptions,
): Promise<freshdesk.CreatedTicket> {
  // Transcript comes from the store, never from whoever asked for the ticket:
  // the agent picking this up must see what was actually said.
  const description = [opts.summary.trim(), "", "— Chat transcript —", transcriptText(conv)]
    .filter(Boolean)
    .join("\n");

  // The visitor's screenshots go WITH the ticket. Without this the agent who
  // picks it up reads "here's the error" and a description of a screenshot
  // they cannot open, and asks the customer to send it a second time.
  const files = await chatFiles.collectForHandoff(conv);

  const created = await freshdesk.createTicket({
    subject: opts.subject,
    description,
    email: opts.email,
    name: conv.visitor.name,
    productHint: opts.productHint ?? conv.visitor.app ?? null,
    // 7 = chat, which is what this is.
    source: 7,
    attachments: files,
  });

  // Internal breadcrumbs, agent-only. Chiefly the link back: a transcript says
  // what was said, not what the visitor did next, and the screenshots read
  // very differently in place.
  //
  // Best-effort. The ticket is the promise made to the customer, and a failed
  // note must never undo one that already exists.
  const note = [
    opts.actor
      ? `Converted from a live chat by ${opts.actor}.`
      : "Opened by Jetta from a live chat.",
    `Conversation: ${conversationUrl(conv.id)}`,
    `Surface: ${conv.surface}${conv.pageUrl ? ` — ${conv.pageUrl}` : ""}`,
    conv.visitor.mondayAccountSlug ? `monday account: ${conv.visitor.mondayAccountSlug}` : "",
    files.length ? `Files attached: ${files.map((f) => f.name).join(", ")}` : "",
  ].filter(Boolean);

  await freshdesk
    .addPrivateNote(created.id, note.join("\n"))
    .catch((e) =>
      console.warn(
        `openTicketForConversation: private note failed on #${created.id}:`,
        e instanceof Error ? e.message : e,
      ),
    );

  return created;
}

/**
 * A starting subject for the console's convert dialog.
 *
 * The first thing the visitor TYPED, not the first message — a chat that opens
 * with a bare screenshot would otherwise be titled with the vision pass's
 * description of a dialog box.
 */
export function suggestedSubject(conv: ChatConversation): string {
  const typed = conv.messages.find((m) => m.author === "visitor" && m.text.trim())?.text ?? "";
  const line = typed.split("\n")[0]!.trim();
  if (!line) return "Support request from live chat";
  return line.length > 70 ? `${line.slice(0, 70)}…` : line;
}
