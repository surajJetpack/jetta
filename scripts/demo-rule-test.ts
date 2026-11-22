/**
 * Jetta says yes to a demo, on every channel, and gives the booking link.
 *
 * A chat visitor asked "do you offer demos?" and was told "we don't currently
 * offer personalised one-on-one demos". Nothing in the prompt said we do, and
 * the only booking rule lived inside the first-reply rules for email tickets,
 * behind an env var production never had.
 *
 *   npx tsx scripts/demo-rule-test.ts
 */
process.env.STUB_MODE = "true";
delete process.env.JETTA_BOOKING_URL;

import type { ConversationContext } from "../lib/types";

let failures = 0;
function check(name: string, pass: boolean, detail?: string) {
  console.log(`${pass ? "  ok  " : "FAIL  "}${name}${!pass && detail ? ` — ${detail}` : ""}`);
  if (!pass) failures++;
}

function ctx(channel: string, extra: Record<string, unknown> = {}): ConversationContext {
  return {
    channel,
    ticket: {
      id: "t-1",
      subject: "do you offer demos?",
      description: "do you offer demos?",
      status: "open",
      requesterName: "Someone",
      requesterEmail: "someone@example.com",
      replies: [],
    },
    account: null,
    relatedDevItems: [],
    product: "getsign",
    appProduct: "unknown",
    app: "unknown",
    kbArticles: [],
    ...extra,
  } as unknown as ConversationContext;
}

async function main() {
  const { config, DEFAULT_BOOKING_URL } = await import("../lib/config");
  const { buildSystemPrompt, demoRules } = await import("../lib/system-prompt");

  check("the booking link is set with no env var", config.bookingUrl === DEFAULT_BOOKING_URL, String(config.bookingUrl));

  const cases: [string, ConversationContext][] = [
    ["jettachat", ctx("jettachat", { chat: { surface: "wordpress", handoffEnabled: true } })],
    ["freshchat", ctx("freshchat")],
    ["freshdesk", ctx("freshdesk")],
    ["freshdesk first reply", ctx("freshdesk", { firstResponse: true })],
  ];
  for (const [label, c] of cases) {
    const prompt = await buildSystemPrompt(c);
    check(`${label}: says we offer demos`, /We DO offer demos/.test(prompt));
    check(`${label}: gives the booking link`, prompt.includes(DEFAULT_BOOKING_URL));
    check(`${label}: no unfilled placeholder`, !/\{\{[A-Z_]+\}\}/.test(prompt), /\{\{[A-Z_]+\}\}/.exec(prompt)?.[0]);
  }

  const off = demoRules(null);
  check("link off: still never denies demos", /We DO offer demos/.test(off) && /NEVER say or imply/.test(off));
  check("link off: no link, a colleague arranges it", !off.includes("https://") && /colleague will arrange/.test(off));

  console.log(failures ? `\n${failures} failed` : "\nall passed");
  process.exit(failures ? 1 : 0);
}
main();
