/**
 * A chat transcript, rendered as the chat it was.
 *
 * A hand-off used to arrive in Freshdesk as `[2026-08-18T05:13:52.754Z]
 * Customer: …` repeated thirty times — every line the same shape, every line
 * led by an ISO timestamp nobody reads, and the two speakers distinguished
 * only by a word in the middle of it. The agent picking the ticket up had to
 * parse the conversation before they could read it.
 *
 * THE PALETTE IS THE WIDGET'S OWN, deliberately and to the pixel where the
 * medium allows: white ground, the visitor's turn on the RIGHT in near-black
 * with white text, Jetta's on the LEFT in light grey, 16px bubbles with a 2px
 * tail corner pointing at the speaker. Read app/chat/page.tsx beside this file
 * — every value here is lifted from it (Tailwind `neutral-900` is #171717,
 * `neutral-100` is #f5f5f5, `rounded-2xl` is 16px, `rounded-bl-sm` is 2px).
 * The point is that a colleague opening the ticket sees what the visitor saw,
 * so anything that drifts from the widget is a bug in this file.
 *
 * Sides included. It looks inverted for a ticket — the customer is usually
 * drawn on the left — but the visitor sat on the right in the conversation
 * being reproduced, and half-matching a design reads worse than not matching
 * it.
 *
 * THREE CONSTRAINTS SHAPE THE REST, all of them unusual:
 *
 *   Freshdesk's description field is customer-visible. It shows in the portal
 *   and gets quoted into the notification email, so this is email HTML, not
 *   web HTML: table layout, inline styles only, no classes, no <style> block.
 *   Verified against a real ticket — Freshdesk keeps all of it and rewrites
 *   only <p> to <div>.
 *
 *   NO IMAGES, which is the one place the widget cannot be matched. Jetta's
 *   avatar there is a ~125 kB data URI, and data: images are blocked outright
 *   by Outlook and most webmail, so it would leave an empty box for a good
 *   share of readers. The widget's own no-avatar fallback is a bare
 *   neutral-200 circle; this draws that circle with the initial in it.
 *
 *   EVERY STRING IS HOSTILE. The visitor typed one half and a language model
 *   wrote the other, and the result lands in a colleague's Freshdesk tab and
 *   in an email client. Escaping is not a nicety here — it is why this file
 *   escapes FIRST and then applies its own markup to the escaped text, so a
 *   visitor's `<img onerror=…>` can never be anything but characters.
 */
import { textWithAttachments } from "./chat-files";
import type { ChatConversation, ChatMessage } from "./types";

/** The widget's palette, by its Tailwind name. Change these only with app/chat/page.tsx open. */
const INK = "#171717"; // neutral-900 — visitor bubble, and body text elsewhere
const BUBBLE = "#f5f5f5"; // neutral-100 — Jetta's bubble
const AVATAR = "#e5e5e5"; // neutral-200 — the widget's no-avatar fallback circle
const LABEL = "#737373"; // neutral-500 — the name above a bubble
const QUIET = "#a3a3a3"; // neutral-400 — timestamps
/**
 * SINGLE quotes, not double. This whole file interpolates into `style="…"`
 * attributes, so a double quote inside the font stack closes the attribute and
 * silently drops every declaration after it — which is exactly what happened:
 * the name and timestamp rows put `font` first, so `text-align:right` and the
 * colours vanished and the visitor's label stopped right-aligning. Valid CSS
 * either way; only one of them survives being an attribute value.
 */
const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;

/** How the widget's settings reach this renderer, so the skin carries over. */
export interface TranscriptSkin {
  /** `accentColor` from chat settings — the widget puts it on a human's initials. */
  accentColor?: string;
  /** `title` from chat settings — what the widget calls the bot above its bubbles. */
  botName?: string;
}

const HEX = /^#[0-9a-f]{6}$/i;

/** HTML-escape. Quotes included: escaped text is interpolated into attributes. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Bare URLs become links. Runs on ALREADY-ESCAPED text, which is why it is
 * safe: the only way `<a` reaches the output is from this line, and the
 * pattern matches http(s) only, so `javascript:` is excluded by construction
 * rather than by filtering for it.
 *
 * `&amp;` inside a query string is correct in an href and resolves back to
 * `&`, so the escaped text doubles as the target. Underlined and colour-
 * inherited, as the widget draws them — which is also what keeps a link
 * legible inside the near-black visitor bubble.
 */
const URL_RE = /https?:\/\/[^\s<>"']+/g;

function linkify(escaped: string): string {
  return escaped.replace(URL_RE, (url) => {
    // Sentence punctuation is not part of the address.
    const trimmed = url.replace(/[.,;:!?]+$/, "");
    const tail = url.slice(trimmed.length);
    return `<a href="${trimmed}" style="color:inherit;text-decoration:underline;word-break:break-word" target="_blank" rel="noopener noreferrer">${trimmed}</a>${tail}`;
  });
}

/** `**bold**` → bold. The model writes markdown however firmly it is asked not to. */
function inline(escaped: string): string {
  return linkify(escaped).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

/**
 * A message body → block HTML.
 *
 * Deliberately a small subset: paragraphs, bullet lists, numbered lists,
 * links, bold. Enough that an answer with three steps reads as three steps,
 * and little enough that the whole surface fits in one screen of code — this
 * runs on model output, and every construct is a place to get escaping wrong.
 */
function blocks(text: string): string {
  const out: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;

  const flush = () => {
    if (!list) return;
    const items = list.items.map((i) => `<li style="margin:2px 0">${i}</li>`).join("");
    out.push(`<${list.tag} style="margin:6px 0;padding-left:20px">${items}</${list.tag}>`);
    list = null;
  };

  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const bullet = BULLET.exec(line);
    const numbered = !bullet ? NUMBERED.exec(line) : null;
    if (bullet || numbered) {
      const tag = bullet ? "ul" : "ol";
      if (list && list.tag !== tag) flush();
      list ??= { tag, items: [] };
      list.items.push(inline(esc((bullet ?? numbered)![1]!)));
      continue;
    }
    flush();
    if (!line.trim()) continue;
    out.push(`<div style="margin:3px 0">${inline(esc(line))}</div>`);
  }
  flush();
  return out.join("") || "<div>&nbsp;</div>";
}

/**
 * "18 Aug, 05:13 UTC" — fixed to UTC on purpose.
 *
 * The widget shows no timestamps at all, because the visitor was there. A
 * transcript is evidence read later by someone who was not, and evidence that
 * renders differently depending on who opens it is worth less than evidence
 * that is merely inconvenient.
 */
function stamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${month}, ${hh}:${mm} UTC`;
}

/**
 * Jetta's circle, or a person's initials in the accent colour.
 *
 * Both are the widget's own rules: a human who takes the conversation over
 * gets TWO letters on the accent, so the visitor can see at a glance that
 * someone real is typing, and the bot gets its face — which here, with no
 * images available, is the widget's fallback circle carrying one letter.
 */
function avatar(name: string, human: boolean, accent: string): string {
  const initials = esc(human ? name.slice(0, 2).toUpperCase() : (name.trim()[0] ?? "?").toUpperCase());
  const skin = human ? `background:${accent};color:#ffffff` : `background:${AVATAR};color:${LABEL}`;
  return (
    `<div style="width:24px;height:24px;border-radius:50%;${skin};float:left;margin-right:8px;` +
    `font:600 10px/24px ${FONT};text-align:center;letter-spacing:.02em">${initials}</div>`
  );
}

function row(m: ChatMessage, visitorName: string, skin: Required<TranscriptSkin>): string {
  const text = textWithAttachments(m.text, m.attachments);
  const time = esc(stamp(m.createdAt));
  const visitor = m.author === "visitor";
  const human = !visitor && m.via === "human";
  const who = visitor ? visitorName : human ? (m.authorName ?? "Support") : skin.botName;

  // rounded-2xl with the tail corner squared off, pointing at its own speaker:
  // bottom-right for the visitor, bottom-left for Jetta.
  const bubble =
    `<div style="${visitor ? "float:right" : "float:left"};max-width:85%;padding:8px 14px;` +
    `border-radius:${visitor ? "16px 16px 2px 16px" : "16px 16px 16px 2px"};` +
    `background:${visitor ? INK : BUBBLE};color:${visitor ? "#ffffff" : INK};` +
    `font:14px/1.6 ${FONT}">${blocks(text)}</div>`;

  const align = visitor ? "text-align:right" : "margin-left:32px";
  const label = `<div style="font:11px/1.4 ${FONT};color:${LABEL};${align};margin-bottom:3px">${esc(who)}</div>`;
  const when = time
    ? `<div style="font:11px/1.4 ${FONT};color:${QUIET};clear:both;padding-top:3px;${align}">${time}</div>`
    : `<div style="clear:both"></div>`;

  // The visitor has no avatar in the widget — they know who they are — and
  // that stays true here; the name label above the bubble is what tells a
  // third-party reader which side is the customer.
  return `<tr><td style="padding:6px 16px">${label}${visitor ? "" : avatar(who, human, skin.accentColor)}${bubble}${when}</td></tr>`;
}

/**
 * The whole transcript as one self-contained table.
 *
 * Returns "" for a conversation with no messages, so the caller can leave the
 * transcript section out entirely rather than shipping an empty frame.
 */
export function transcriptHtml(conv: ChatConversation, skin: TranscriptSkin = {}): string {
  if (!conv.messages.length) return "";
  const resolved: Required<TranscriptSkin> = {
    // A junk accent must not reach a style attribute, and the widget's own
    // default is this same near-black.
    accentColor: HEX.test(skin.accentColor ?? "") ? skin.accentColor! : INK,
    botName: skin.botName?.trim() || "Jetta",
  };
  const visitorName = conv.visitor.name?.trim() || "Customer";
  const rows = conv.messages.map((m) => row(m, visitorName, resolved)).join("");
  return (
    `<table style="width:100%;max-width:560px;background:#ffffff;border-collapse:collapse;margin:0">` +
    `<tbody>${rows}</tbody></table>`
  );
}
