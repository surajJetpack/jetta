/**
 * Tidy an email message body for reading.
 *
 * Freshdesk already removes the quoted history from `body_text` (it cuts at its
 * own `freshdesk_quote` wrapper — checked on 40 incoming messages across 8
 * threads, 2026-11-03, where a 200 KB HTML body came down to under 1 KB of
 * text). What it leaves behind is the reply header that introduced the quote
 * ("On Mon, Oct 12, 2026 at 3:18 PM App Support"), Outlook's `____` separator,
 * and link-protection URLs (Outlook safelinks, INKY) that run to 500+
 * characters each. Those are trimmed here; nothing else is rewritten.
 */

/** Link-protection wrappers whose URL is noise; the visible text before them is kept. */
const WRAPPED_LINK = /<?https?:\/\/(?:[a-z0-9-]+\.)*(?:safelinks\.protection\.outlook\.com|shared\.outlook\.inky\.com|urldefense\.(?:com|proofpoint\.com)|linkprotect\.cudasvc\.com)\/[^\s>]*>?/gi;

/** A line that opens a quoted reply, whatever client wrote it. */
const REPLY_HEADERS: RegExp[] = [
  // Gmail / Apple Mail: "On Mon, Oct 12, 2026 at 3:18 PM App Support <x@y> wrote:" —
  // FD's cut often lands before "wrote:", so the tail is optional.
  /^\s*On .{4,200}\d{1,2}:\d{2}.*$/m,
  /^\s*On .{4,200}wrote:\s*$/m,
  // Outlook: separator line, or the From/Sent header block.
  /^\s*_{10,}\s*$/m,
  /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/im,
  /^\s*From:\s.+\n\s*(?:Sent|Date):\s/m,
];

export function cleanEmailText(text: string | null | undefined): string {
  if (!text) return "";
  let out = text
    .replace(/\r\n?/g, "\n")
    .replace(WRAPPED_LINK, "")
    // Outlook's "name@x.com<mailto:name@x.com>" and "site.com<http://site.com/>" echoes.
    .replace(/<(?:mailto:|https?:\/\/)[^\s>]{1,300}>/gi, "");

  // Cut at the earliest reply header — only past the first line, so a message
  // that IS just a header (rare forwards) is not emptied.
  let cut = out.length;
  for (const re of REPLY_HEADERS) {
    const m = re.exec(out);
    if (m && m.index > 0 && m.index < cut) cut = m.index;
  }
  out = out.slice(0, cut);

  return out
    .replace(/[ \t ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
