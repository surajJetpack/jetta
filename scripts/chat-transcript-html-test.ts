/**
 * The chat transcript that goes into a Freshdesk ticket.
 *
 * Two things are being pinned here and they pull in opposite directions.
 *
 * READABILITY — the reason this exists. A hand-off used to arrive as thirty
 * ISO-stamped lines of the same shape, so the agent had to parse the
 * conversation before reading it. Bubbles, sides, names, times.
 *
 * SAFETY — the reason it is dangerous. Half of every transcript was typed by
 * an anonymous visitor and the other half written by a language model, and the
 * result lands in a colleague's Freshdesk tab and in a notification email.
 * There is no sanitiser downstream that we control, so the escaping is the
 * whole defence and it is asserted character by character.
 *
 *   npx tsx scripts/chat-transcript-html-test.ts          # run the checks
 *   npx tsx scripts/chat-transcript-html-test.ts --write  # + write a preview
 *
 * The preview lands in the scratch dir and is worth opening in a browser the
 * first time you change the layout: none of these checks can tell you it
 * looks right, only that it cannot bite.
 */
export {};

import { writeFileSync } from "node:fs";
import type { ChatConversation, ChatMessage } from "../lib/types";
import { transcriptHtml } from "../lib/chat-transcript-html";

let failures = 0;
function check(name: string, pass: boolean, detail?: string) {
  console.log(`${pass ? "  ok  " : "FAIL  "}${name}${!pass && detail ? ` — ${detail}` : ""}`);
  if (!pass) failures++;
}

let n = 0;
function msg(m: Partial<ChatMessage> & Pick<ChatMessage, "author" | "text">): ChatMessage {
  n++;
  return {
    id: `m${n}`,
    createdAt: `2026-08-18T05:${String(10 + n).padStart(2, "0")}:00.000Z`,
    ...m,
  } as ChatMessage;
}

function conv(messages: ChatMessage[], name: string | null = "Ben Newton"): ChatConversation {
  return {
    id: "c1",
    surface: "wordpress",
    status: "open",
    visitor: { name: name ?? undefined, email: "ben@greenfinchuk.com", app: "getsign" },
    messages,
    createdAt: "2026-08-18T05:10:00.000Z",
    updatedAt: "2026-08-18T05:20:00.000Z",
  } as unknown as ChatConversation;
}

function main() {
  // ── Safety: every string in here is hostile ────────────────────────
  const nasty = transcriptHtml(
    conv([
      msg({ author: "visitor", text: `<img src=x onerror="alert(1)">` }),
      msg({ author: "agent", text: `</div><script>alert("xss")</script>` }),
      msg({ author: "visitor", text: `click <a href="javascript:alert(1)">here</a>` }),
    ]),
  );
  check("a visitor's img tag is inert text", !/<img/i.test(nasty), "an <img> reached the output");
  check("a script tag never survives", !/<script/i.test(nasty));
  check(
    "an injected anchor never becomes a live link",
    !/href="javascript:/i.test(nasty) && nasty.includes("&lt;a href=&quot;javascript:"),
    "the scheme must survive as visible text and never as an href",
  );
  check(
    "the angle brackets are still READABLE as what was typed",
    nasty.includes("&lt;img src=x onerror=") && nasty.includes("&lt;script&gt;"),
    "escaping must preserve the evidence, not delete it",
  );
  // A quote that escapes its attribute is the subtler version of the same bug.
  const quoted = transcriptHtml(conv([msg({ author: "visitor", text: `" style="display:none` })]));
  check("a double quote cannot break out of an attribute", !/" style="display:none/.test(quoted));

  // ── The one place a real tag is emitted ────────────────────────────
  const linked = transcriptHtml(
    conv([msg({ author: "agent", text: "See https://support.getsign.io/a?x=1&y=2 for the steps." })]),
  );
  check("a bare URL becomes a link", /<a href="https:\/\/support\.getsign\.io\/a\?x=1&amp;y=2"/.test(linked), linked.slice(0, 200));
  check("and only http(s) ever does", (linked.match(/<a href=/g) ?? []).length === 1);
  const punct = transcriptHtml(conv([msg({ author: "agent", text: "Read https://getsign.io/help." })]));
  check(
    "a full stop is not part of the address",
    punct.includes('href="https://getsign.io/help"') && punct.includes("</a>."),
  );

  // ── Readability: the reason any of this exists ─────────────────────
  const real = conv([
    msg({ author: "visitor", text: "It only sends the contract to me, not my client." }),
    msg({
      author: "agent",
      text: "Thanks for explaining. A few things to check:\n- The email field must map to the client\n- Add them under **Request signatures from**\n\nWhich flow are you using?",
    }),
    msg({ author: "agent", text: "I've passed this to a colleague.", via: "human", authorName: "Priya" }),
  ]);
  const html = transcriptHtml(real);
  check("the visitor is named from the conversation", html.includes("Ben Newton"));
  check("the bot is named Jetta", html.includes(">Jetta<"));
  check(
    "a human takeover is attributed to the person, not the bot",
    html.includes(">Priya<"),
    "a transcript that calls a colleague 'Jetta' makes the escalation unreadable",
  );
  check("bullets render as a list", html.includes("<ul") && (html.match(/<li/g) ?? []).length === 2);
  check(
    "bold survives as bold, carrying its own weight",
    /<strong style="color:inherit;font-weight:700">Request signatures from<\/strong>/.test(html),
    "an unstyled <strong> is something the host stylesheet may flatten",
  );
  check("times are shown, and in UTC", /18 Aug, 05:\d\d UTC/.test(html), html.slice(0, 300));

  /*
   * ── The widget's own skin ────────────────────────────────────────
   *
   * These are the checks that keep the ticket looking like the chat. Every
   * value is lifted from app/chat/page.tsx; if that file's palette changes and
   * this one does not, the transcript silently stops matching the product it
   * is reproducing, and nothing else would notice.
   */
  check(
    "the visitor sits on the RIGHT, as they did in the widget",
    /float:right;max-width:85%[^"]*background:#171717;color:#ffffff/.test(html),
    "neutral-900 bubble, white text, right-hand side",
  );
  check(
    "Jetta sits on the left in neutral-100",
    /float:left;max-width:85%[^"]*background:#f5f5f5;color:#171717/.test(html),
  );
  check(
    "the tail corner points at its own speaker",
    html.includes("border-radius:16px 16px 2px 16px") && html.includes("border-radius:16px 16px 16px 2px"),
    "rounded-2xl with rounded-br-sm / rounded-bl-sm",
  );
  check("the ground is white, like the widget frame", html.includes("background:#ffffff;border-collapse"));

  /*
   * Our OWN style strings must survive being attribute values.
   *
   * This shipped broken once: the font stack quoted "Segoe UI" with double
   * quotes, which closed every style="…" it appeared in and silently dropped
   * each declaration after it. The name and timestamp rows put `font` first,
   * so the alignment and colours went and nothing failed — the bubbles still
   * looked fine because their font came last.
   */
  check(
    "no style attribute is cut short by a quote of our own",
    (html.match(/-apple-system/g) ?? []).length === (html.match(/sans-serif/g) ?? []).length,
    `${(html.match(/-apple-system/g) ?? []).length} font stacks opened, ${(html.match(/sans-serif/g) ?? []).length} closed`,
  );
  /*
   * ── Nothing inside a bubble may inherit its colour ───────────────
   *
   * Reported from a real ticket: the customer's message was invisible. The
   * bubble carried color:#ffffff and the paragraph inside it carried only a
   * margin, so Freshdesk's own stylesheet — which targets descendants
   * directly — beat the inherited white and painted dark text on the
   * near-black bubble. An inline style outranks any non-!important rule, so
   * every generated element has to state its own colour.
   */
  check(
    "no paragraph inside a bubble is left bare",
    !/style="margin:3px 0"/.test(html),
    "a bare inner div inherits nothing once the host stylesheet has an opinion",
  );
  check("no list item is left bare", !/style="margin:2px 0"/.test(html));
  check("no <strong> is left bare", !/<strong>/.test(html));
  check(
    "the visitor's text is stated white, not merely inherited",
    (html.match(/color:#ffffff/g) ?? []).length >= 2,
    "once on the bubble is not enough — it must be on the text too",
  );
  check(
    "Jetta's text is stated dark on its own elements",
    (html.match(/color:#171717/g) ?? []).length >= 2,
  );

  check(
    "the visitor's name and time stay right-aligned with their bubble",
    (html.match(/text-align:right/g) ?? []).length >= 2,
    "the declaration that used to be eaten by the broken font stack",
  );
  check(
    "the visitor gets no avatar, exactly as in the widget",
    (html.match(/border-radius:50%/g) ?? []).length === 2,
    "one circle per agent turn, none for the visitor",
  );
  check(
    "a human's initials are TWO letters on the accent",
    html.includes(">PR<"),
    "the widget uses who.slice(0,2).toUpperCase() so a real person is obvious",
  );

  // The skin travels from chat settings, so a GetSign hand-off is in GetSign's
  // colours rather than the portfolio's.
  const skinned = transcriptHtml(
    conv([msg({ author: "agent", text: "hi", via: "human", authorName: "Priya" })]),
    { accentColor: "#2563eb", botName: "GetSign Assistant" },
  );
  check("the accent colour reaches the person's avatar", skinned.includes("background:#2563eb"));
  const named = transcriptHtml(conv([msg({ author: "agent", text: "hi" })]), { botName: "GetSign Assistant" });
  check("the bot wears the brand's name for the bot", named.includes(">GetSign Assistant<"));
  const junk = transcriptHtml(
    conv([msg({ author: "agent", text: "hi", via: "human", authorName: "Priya" })]),
    { accentColor: "red;background:url(x)" },
  );
  check(
    "a junk accent cannot reach a style attribute",
    !junk.includes("url(x)") && junk.includes("background:#171717"),
    "settings are console-editable, so this is untrusted input too",
  );

  // ── Email-client constraints ───────────────────────────────────────
  check("no external images", !/<img/i.test(html), "data: and remote images are blocked by most mail clients");
  check("no stylesheet dependency", !/<style|class=/i.test(html));
  check("it is a table, because that is what email renders", html.startsWith("<table"));

  // ── Degenerate input ───────────────────────────────────────────────
  check("an empty conversation renders nothing at all", transcriptHtml(conv([])) === "");
  check(
    "a nameless visitor still gets a label",
    transcriptHtml(conv([msg({ author: "visitor", text: "hi" })], null)).includes("Customer"),
  );
  check(
    "an empty message body does not collapse the bubble",
    transcriptHtml(conv([msg({ author: "visitor", text: "" })])).includes("&nbsp;"),
  );
  const badTime = transcriptHtml(
    conv([{ id: "x", author: "visitor", text: "hi", createdAt: "not-a-date" } as unknown as ChatMessage]),
  );
  check("an unparseable timestamp is dropped, not printed as Invalid Date", !/Invalid/.test(badTime));

  if (process.argv.includes("--write")) {
    const out = `${process.env.TMPDIR ?? "/tmp"}transcript-preview.html`;
    writeFileSync(out, `<!doctype html><meta charset="utf-8"><body style="margin:0;padding:24px;background:#fff">${html}</body>`);
    console.log(`\npreview written to ${out}`);
  }

  console.log(failures ? `\n${failures} failed.` : "\nAll checks passed.");
  process.exit(failures ? 1 : 0);
}

main();
