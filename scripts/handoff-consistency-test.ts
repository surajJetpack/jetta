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
      check(`${label}  tells her to go silent afterwards`, /STOP\. Send nothing further/i.test(prompt));
    } else {
      check(`${label}  still offers the ticket as the honest route`, /offer is a ticket/i.test(prompt));
      check(
        `${label}  create_support_ticket survives handoff being off`,
        tools.includes("create_support_ticket"),
        tools.join(", "),
      );
    }

    // Whatever the setting, the placeholder must have been substituted.
    check(`${label}  no unsubstituted template left in the prompt`, !prompt.includes("{{HANDOFF_RULES}}"));
  }
}

void main().then(() => {
  console.log(failures ? `\n${failures} failing\n` : "\nPrompt and tools agree\n");
  process.exit(failures ? 1 : 0);
});
