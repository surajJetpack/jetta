/**
 * A chat transcript, rendered as chat.
 *
 * A hand-off used to arrive in Freshdesk as `[2026-08-18T05:13:52.754Z]
 * Customer: …` repeated thirty times — every line the same shape, every line
 * led by an ISO timestamp nobody reads, and the two speakers distinguished
 * only by a word in the middle of it. The agent picking the ticket up has to
 * parse the conversation before they can read it, and the one thing they
 * actually want — what did the customer say, in their own words — is the part
 * buried deepest.
 *
 * So: bubbles. Customer on the left, Jetta on the right, the way the
 * conversation looked when it happened.
 *
 * THE CONSTRAINTS THIS IS WRITTEN AGAINST, all of them unusual:
 *
 *   Freshdesk's description field is customer-visible. It shows in the portal
 *   and gets quoted into the notification email, so this is email HTML, not
 *   web HTML: table layout, inline styles only, no classes, no <style> block,
 *   nothing that depends on a stylesheet arriving.
 *
 *   NO EXTERNAL IMAGES. Not the bot avatar from chat settings either — it is
 *   a ~125 kB data URI, and data: images are blocked outright by Outlook and
 *   most webmail. The avatars here are drawn with a background colour and a
 *   letter, so they render identically everywhere and cost nothing.
 *
 *   EVERY STRING IS HOSTILE. The visitor typed one half and a language model
 *   wrote the other, and the result lands in a colleague's Freshdesk tab and
 *   in an email client. Escaping is not a nicety here — it is the reason this
 *   file escapes FIRST and then applies its own markup to the escaped text,
 *   so a visitor's `<img onerror=…>` can never be anything but characters.
 */
import { textWithAttachments } from "./chat-files";
import type { ChatConversation, ChatMessage } from "./types";

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
 * safe: the only way a `<a` reaches the output is from this line, and the
 * pattern matches http(s) only, so `javascript:` is excluded by construction
 * rather than by filtering for it.
 *
 * `&amp;` inside a query string is correct in an href and resolves back to
 * `&`, so the escaped text doubles as the target.
 */
const URL_RE = /https?:\/\/[^\s<>"']+/g;

function linkify(escaped: string): string {
  return escaped.replace(URL_RE, (url) => {
    // Sentence punctuation is not part of the address.
    const trimmed = url.replace(/[.,;:!?]+$/, "");
    const tail = url.slice(trimmed.length);
    return `<a href="${trimmed}" style="color:#1f6feb;word-break:break-word" target="_blank" rel="noopener noreferrer">${trimmed}</a>${tail}`;
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
function body(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;

  const flush = () => {
    if (!list) return;
    const items = list.items.map((i) => `<li style="margin:2px 0">${i}</li>`).join("");
    out.push(`<${list.tag} style="margin:6px 0;padding-left:20px">${items}</${list.tag}>`);
    list = null;
  };

  for (const raw of lines) {
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
    out.push(`<div style="margin:4px 0">${inline(esc(line))}</div>`);
  }
  flush();
  return out.join("") || "<div>&nbsp;</div>";
}

/**
 * "18 Aug, 05:13 UTC" — fixed to UTC on purpose.
 *
 * A transcript is evidence, and evidence that renders differently depending on
 * who opens it is worth less than evidence that is merely inconvenient. The
 * reader is a support agent comparing this against logs, not someone deciding
 * whether they are late for something.
 */
function stamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = String(d.getUTCDate());
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day} ${month}, ${hh}:${mm} UTC`;
}

/** Who said it, and how to paint them. */
function speaker(m: ChatMessage, visitorName: string | null) {
  if (m.author === "visitor") {
    return { name: visitorName || "Customer", side: "left" as const, tint: "#2f6f9f" };
  }
  // A person who took the conversation over is not the bot, and a transcript
  // that calls them "Jetta" makes the escalation impossible to follow.
  if (m.via === "human") {
    return { name: m.authorName || "Support", side: "right" as const, tint: "#2f7d54" };
  }
  return { name: "Jetta", side: "right" as const, tint: "#4b4b7a" };
}

/** The letter circle that stands in for an avatar. */
function badge(name: string, tint: string, side: "left" | "right"): string {
  const initial = esc((name.trim()[0] ?? "?").toUpperCase());
  const corners = side === "left" ? "50% 6px 50% 50%" : "6px 50% 50% 50%";
  const float = side === "left" ? "float:left;margin-right:8px" : `float:right;margin-left:8px;clear:right`;
  return (
    `<div style="width:30px;height:30px;border-radius:${corners};background:${tint};color:#fff;` +
    `font:600 13px/30px -apple-system,Segoe UI,Helvetica,Arial,sans-serif;text-align:center;${float}">${initial}</div>`
  );
}

function row(m: ChatMessage, visitorName: string | null): string {
  const { name, side, tint } = speaker(m, visitorName);
  const text = textWithAttachments(m.text, m.attachments);
  const time = stamp(m.createdAt);
  const left = side === "left";

  // The bubble's flat corner points at its own avatar, which is what makes the
  // two sides readable at a glance without reading a single name.
  const bubble =
    `<div style="${left ? "float:left" : "float:right"};max-width:420px;padding:10px 13px;` +
    `border-radius:${left ? "4px 18px 18px 18px" : "18px 4px 18px 18px"};` +
    `background:${left ? "#a8ddfd" : "#ffffff"};${left ? "" : "border:1px solid #e4e7eb;"}` +
    `font:14px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#3f3f46">${body(text)}</div>`;

  const label =
    `<div style="font-size:12px;color:#6f7071;${left ? "margin-left:38px" : "text-align:right;margin-right:38px"}">${esc(name)}</div>`;
  const when =
    `<div style="font-size:11px;color:#999999;clear:both;${left ? "margin-left:38px" : "text-align:right;margin-right:38px"}">${esc(time)}</div>`;

  return (
    `<tr><td style="padding:8px 16px">${label}${badge(name, tint, side)}${bubble}${when}</td></tr>`
  );
}

/**
 * The whole transcript as one self-contained table.
 *
 * Returns "" for a conversation with no messages, so the caller can leave the
 * transcript section out entirely rather than shipping an empty frame.
 */
export function transcriptHtml(conv: ChatConversation): string {
  if (!conv.messages.length) return "";
  const visitorName = conv.visitor.name ?? null;
  const rows = conv.messages.map((m) => row(m, visitorName)).join("");
  return (
    `<table style="width:100%;max-width:640px;background:#f4f8fa;border-collapse:collapse;margin:0">` +
    `<tbody>${rows}</tbody></table>`
  );
}
