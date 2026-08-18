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
  check("bold survives as bold", html.includes("<strong>Request signatures from</strong>"));
  check("times are shown, and in UTC", /18 Aug, 05:\d\d UTC/.test(html), html.slice(0, 300));
  check(
    "the two speakers land on opposite sides",
    html.includes("float:left") && html.includes("float:right"),
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
