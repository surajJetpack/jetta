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
import { transcriptHtml } from "./chat-transcript-html";
import { getChatSettings, publicSettings } from "./chat-settings";
import { conversationUrl } from "./tools/jettachat";
import type { AppProduct, ChatConversation, ChatMessage } from "./types";

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

/**
 * A ticket, plus where the transcript it carries ends.
 *
 * `syncMark` is the `createdAt` of the last message that actually went to
 * Freshdesk, and it belongs to this function because this function is the only
 * one that knows: it is handed a SNAPSHOT of the conversation and then spends
 * however long a multipart attachment upload takes talking to Freshdesk.
 *
 * The caller must store it as `lastTicketSyncAt`. Stamping "now" instead loses
 * every message the visitor sent during that upload — they are not in the
 * transcript, because the snapshot predates them, and not in the first delta,
 * because a mark set at patch time is already past them. It is the one class of
 * message the post-ticket state exists to carry, and nothing reports it
 * missing: the ticket opens, the note posts, and the detail is simply gone.
 *
 * Undefined only for a conversation with no messages at all.
 */
export type OpenedTicket = freshdesk.CreatedTicket & { syncMark?: string };

export async function openTicketForConversation(
  conv: ChatConversation,
  opts: OpenTicketOptions,
): Promise<OpenedTicket> {
  // Transcript comes from the store, never from whoever asked for the ticket:
  // the agent picking this up must see what was actually said.
  const description = [opts.summary.trim(), "", "— Chat transcript —", transcriptText(conv)]
    .filter(Boolean)
    .join("\n");

  // ...and it goes in as CHAT. The plain-text version above is kept as the
  // fallback and as what the stub path logs, but a hand-off that arrives as
  // thirty identically-shaped ISO-stamped lines makes the agent parse the
  // conversation before they can read it. See lib/chat-transcript-html.ts for
  // why this is email HTML and why it escapes before it formats.
  // The transcript wears the skin the visitor actually saw. Resolved through
  // the brand profile exactly as /api/chat/config resolves it for the widget,
  // so a GetSign conversation hands over in GetSign's accent and under
  // whatever that brand calls the bot — a transcript in the wrong brand's
  // colours is a small thing that reads as the wrong conversation.
  //
  // Best-effort: a settings read that fails must not cost the customer their
  // ticket, and the renderer's defaults are the widget's own.
  const skin = await getChatSettings()
    .then((s) => publicSettings(s, conv.visitor.app === "getsign" ? "getsign" : "main"))
    .then((s) => ({ accentColor: s.accentColor, botName: s.title }))
    .catch(() => ({}));

  const bubbles = transcriptHtml(conv, skin);
  const descriptionHtml = bubbles
    ? [
        opts.summary.trim() ? freshdesk.textToFdHtml(opts.summary.trim()) : "",
        `<p style="margin:16px 0 6px;font:600 12px -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#6f7071;text-transform:uppercase;letter-spacing:.04em">Chat transcript</p>`,
        bubbles,
      ]
        .filter(Boolean)
        .join("")
    : undefined;

  // The visitor's screenshots go WITH the ticket. Without this the agent who
  // picks it up reads "here's the error" and a description of a screenshot
  // they cannot open, and asks the customer to send it a second time.
  const files = await chatFiles.collectForHandoff(conv);

  const created = await freshdesk.createTicket({
    subject: opts.subject,
    description,
    descriptionHtml,
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
    // One chat can raise more than one issue, and each gets its own ticket.
    // Whoever picks this up should know the others exist — the transcript
    // below covers the whole conversation, so without this line they would
    // read about a problem already being worked and have no way to tell.
    conv.ticketId ? `Earlier ticket from this chat: #${conv.ticketId}` : "",
    conv.previousTicketIds?.length
      ? `Earlier still: ${conv.previousTicketIds.map((t) => `#${t}`).join(", ")}`
      : "",
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

  // Taken from the snapshot, not from the clock: this is where the transcript
  // above ends, whatever has arrived since.
  return { ...created, syncMark: conv.messages.at(-1)?.createdAt };
}

/**
 * Where an update from a still-running chat should go.
 *
 * Pulled out as a pure function for the same reason `chooseDelivery` was: it is
 * a three-way branch on a remote system's state that cannot be exercised
 * without one, and the branch most likely to be got wrong is the one that looks
 * like an edge case. `status` is null when the Freshdesk lookup FAILED, and
 * that must route to "note" — treating an unreachable API as a closed ticket
 * would spray duplicate tickets across the team every time Freshdesk had a bad
 * minute. Only a status we actually read, and that is actually terminal, moves
 * off the default.
 */
export type TicketUpdateRoute =
  /** Add a private note to the existing ticket — the normal path. */
  | { kind: "note" }
  /**
   * The old ticket is finished; open a fresh one carrying the conversation.
   * The address is carried on the branch rather than re-derived by the caller,
   * so "we only replace when we have somewhere to reply" is one invariant in
   * one place instead of a non-null assertion at the call site.
   */
  | { kind: "replace"; status: string; email: string }
  /** It needs a new ticket and we have no requester address. */
  | { kind: "needs_email"; status: string };

export function routeTicketUpdate(
  status: string | null,
  email: string | undefined,
): TicketUpdateRoute {
  if (!status || !freshdesk.isTerminalStatus(status)) return { kind: "note" };
  const trimmed = email?.trim();
  return trimmed ? { kind: "replace", status, email: trimmed } : { kind: "needs_email", status };
}

/*
 * Is a SECOND ticket for this conversation really a second issue?
 *
 * Once a chat has a ticket the model holds both create_support_ticket and
 * add_to_ticket, and the one-ticket-per-issue rule lives in prose. Prose lost:
 * tickets #14245 and #14246 were opened two minutes apart from one chat, for
 * one 403 login problem — the second one existed only to carry a screenshot,
 * and its own back-link note named the first. So the judgement is checked
 * here too, on the two signals that case left behind, and a match sends the
 * model back to add_to_ticket, which carries the same messages and files as a
 * note on the ticket that already exists.
 *
 * Pure, like routeTicketUpdate, so the contract suite can pin the thresholds.
 * Two rules, either of which is enough:
 *
 *  - The requested subject names the same problem as the ticket's. Compared on
 *    content words only — stopwords and the words every support subject shares
 *    ("error", "issue", "getsign") are dropped first, so "Question about my
 *    invoice" and "Question about the login page" do NOT match, while "403 on
 *    login for colleague" and "403 login — colleague can't access" do.
 *  - Since the ticket was last pushed to, the visitor sent a file and barely
 *    any text. "Here's the screenshot" is more detail, not a new issue. A
 *    genuinely new problem comes with a sentence explaining it.
 *
 * False positives cost a note on a ticket that should have been its own
 * thread; the team can split it. False negatives cost the duplicate above.
 * The prompt's own tie-break — "if you are unsure, it is the same issue" —
 * points the same way.
 */

/** Dice score over stemmed content words at or above which two subjects are one problem. */
export const SAME_ISSUE_SUBJECT_SCORE = 0.5;
/** ...and at least this many content words in common, so one shared word cannot decide. */
export const SAME_ISSUE_MIN_SHARED_WORDS = 2;
/** With a file attached, fewer typed words than this since the last push is "here it is", not a new issue. */
export const SAME_ISSUE_MAX_WORDS_WITH_FILE = 10;

const SUBJECT_NOISE = new Set([
  // stopwords
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at", "for", "from", "with", "by",
  "about", "into", "is", "are", "was", "were", "be", "been", "it", "its", "my", "our", "your", "their",
  "his", "her", "this", "that", "these", "those", "i", "we", "you", "they", "me", "us", "can", "cant",
  "cannot", "not", "no", "do", "does", "did", "have", "has", "had", "when", "how", "why", "what", "re",
  // words every support subject shares — they say "support", not which problem
  "question", "questions", "issue", "issues", "problem", "problems", "error", "errors", "help", "request",
  "support", "urgent", "working", "work", "works", "need", "needs", "please", "getsign", "monday", "com",
  "app", "apps", "jetpack", "jetpackapps", "chat",
]);

/** Crude stem so "syncing" / "sync" / "synced" count as one word. */
function stem(w: string): string {
  if (w.length <= 4) return w;
  return w.replace(/(ing|ed|es|s)$/, "");
}

/** The words of a subject that actually name its problem. */
export function subjectContentWords(subject: string): string[] {
  return subject
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !SUBJECT_NOISE.has(w))
    .map(stem);
}

export type SecondTicketVerdict =
  | { kind: "allow" }
  | { kind: "same_issue"; reason: "subject" | "file_only" };

export function judgeSecondTicket(input: {
  /** Subject the active ticket was opened with; absent on conversations ticketed before it was stored. */
  existingSubject: string | undefined;
  requestedSubject: string;
  /** Messages since the last push to the active ticket (the same delta add_to_ticket would carry). */
  fresh: ChatMessage[];
}): SecondTicketVerdict {
  if (input.existingSubject) {
    const a = subjectContentWords(input.existingSubject);
    const b = subjectContentWords(input.requestedSubject);
    if (a.length && b.length) {
      const pool = new Map<string, number>();
      for (const w of a) pool.set(w, (pool.get(w) ?? 0) + 1);
      let shared = 0;
      for (const w of b) {
        const n = pool.get(w) ?? 0;
        if (n > 0) {
          shared++;
          pool.set(w, n - 1);
        }
      }
      const score = (2 * shared) / (a.length + b.length);
      if (score >= SAME_ISSUE_SUBJECT_SCORE && shared >= SAME_ISSUE_MIN_SHARED_WORDS) {
        return { kind: "same_issue", reason: "subject" };
      }
    }
  }

  const visitor = input.fresh.filter((m) => m.author === "visitor" && !m.system);
  const files = visitor.reduce((n, m) => n + (m.attachments?.length ?? 0), 0);
  if (files > 0) {
    const typed = visitor
      .map((m) => m.text.trim())
      .join(" ")
      .split(/\s+/)
      .filter(Boolean).length;
    if (typed < SAME_ISSUE_MAX_WORDS_WITH_FILE) return { kind: "same_issue", reason: "file_only" };
  }

  return { kind: "allow" };
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
