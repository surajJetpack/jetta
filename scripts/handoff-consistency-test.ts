/**
 * The prompt and the tool list must agree about whether a person can be
 * fetched into a live chat.
 *
 * They disagreed for weeks: the prompt said "no one is watching this widget"
 * and "never tell the customer a human will join the chat", while `request_human`
 * sat in the toolset pinging a Slack channel someone was in fact watching.
 * Jetta was being told her own capability was impossible.
 *
 * Worse, the console's "let Jetta hand a live chat to a person" checkbox was
 * read by nothing at all, so turning it off changed neither half.
 *
 *   npx tsx scripts/handoff-consistency-test.ts
 */
process.env.STUB_MODE = "true";

import type { ConversationContext } from "../lib/types";

let failures = 0;
function check(name: string, pass: boolean, detail?: string) {
  console.log(`${pass ? "  ok  " : "FAIL  "}${name}${!pass && detail ? ` — ${detail}` : ""}`);
  if (!pass) failures++;
}

function ctxWith(handoffEnabled: boolean): ConversationContext {
  return {
    channel: "jettachat",
    ticket: {
      id: "conv-1",
      subject: "[Chat] my board is blank",
      description: "my board is blank",
      status: "open",
      requesterName: "Someone",
      requesterEmail: "someone@example.com",
      replies: [],
    },
    account: null,
    relatedDevItems: [],
    product: "jetpackapps",
    appProduct: "unknown",
    app: "unknown",
    kbArticles: [],
    chat: { surface: "wordpress", handoffEnabled },
  } as unknown as ConversationContext;
}

async function main() {
  const { buildSystemPrompt } = await import("../lib/system-prompt");
  const { buildTools } = await import("../lib/tools");

  for (const enabled of [true, false]) {
    const ctx = ctxWith(enabled);
    const prompt = await buildSystemPrompt(ctx);
    const tools = Object.keys(buildTools(ctx, {} as never));
    const hasTool = tools.includes("request_human");
    const label = enabled ? "handoff ON " : "handoff OFF";

    console.log(`\n${label}`);
    check(`${label}  request_human ${enabled ? "offered" : "withheld"}`, hasTool === enabled, tools.join(", "));

    // The contradiction itself: this sentence must never appear while the tool does.
    const saysNobodyWatching = /no one is watching this widget|nobody is watching it live/i.test(prompt);
    check(
      `${label}  prompt does not deny handoff while offering it`,
      !(hasTool && saysNobodyWatching),
      "prompt says nobody is watching AND request_human is available",
    );

    const mentionsTool = /request_human/.test(prompt);
    check(`${label}  prompt ${enabled ? "explains" : "never mentions"} request_human`, mentionsTool === enabled);

    if (enabled) {
      check(
        `${label}  hedges the promise (asking, not arriving)`,
        /never promise a person will arrive/i.test(prompt),
      );
      // Was "STOP. Send nothing further" until 2026-08-15. That bullet fought
      // the one above it — one said how to word the message, the next said not
      // to send one — and she resolved it both ways on different runs. The
      // silent resolution is the damaging one: runChatTurn treats an empty
      // reply as a failed run, so a visitor who asked for a person got the
      // crash apology instead. The contract is now one message, then stop.
      check(
        `${label}  tells her to send exactly one message, then stop`,
        /EXACTLY ONE short message/i.test(prompt) && /then stop/i.test(prompt),
      );
      // The rule that describing was not enough for. She obeyed "never promise
      // a person will arrive" and then wrote "Someone will be with you
      // shortly" anyway — the idiom is stronger than the paraphrase, so the
      // exact strings have to be named where handoff is ON, not only where it
      // is off.
      check(
        `${label}  names the forbidden phrases, not just the rule`,
        /someone will be with you shortly/i.test(prompt) && /FORBIDDEN/.test(prompt),
      );
      check(
        `${label}  gives her wording to use instead`,
        /if someone's free they'll jump in/i.test(prompt),
      );
    } else {
      check(`${label}  still offers the ticket as the honest route`, /correct route is the ticket/i.test(prompt));
      check(
        `${label}  create_support_ticket survives handoff being off`,
        tools.includes("create_support_ticket"),
        tools.join(", "),
      );
    }

    // Whatever the setting, EVERY placeholder must have been substituted —
    // matched generically, so a new one added to JETTACHAT_RULES is covered
    // the day it lands rather than the day someone remembers this line.
    const leftovers = prompt.match(/\{\{[A-Z_]+\}\}/g) ?? [];
    check(`${label}  no unsubstituted template left in the prompt`, !leftovers.length, leftovers.join(", "));
  }
}

void main().then(() => {
  console.log(failures ? `\n${failures} failing\n` : "\nPrompt and tools agree\n");
  process.exit(failures ? 1 : 0);
});
