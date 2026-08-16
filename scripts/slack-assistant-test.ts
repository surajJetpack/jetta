/**
 * Smoke test for Jetta's Slack DM assistant.
 *   npx tsx --env-file=.env.local scripts/slack-assistant-test.ts
 *   npx tsx --env-file=.env.local scripts/slack-assistant-test.ts "your own question"
 *   STUB_MODE=true FRESHDESK_LIVE=true SLACK_LIVE=false \
 *     npx tsx --env-file=.env.local scripts/slack-assistant-test.ts --deliver
 *
 * Hits live Freshdesk/KB/monday reads and a real model call, so it costs a few
 * cents and takes a minute.
 *
 * Without `--deliver` she has no conversation to upload into, so the file tool
 * is never built and nothing she does can write anywhere — which is what the
 * refusal cases prove. `--deliver` gives her one, and belongs with Slack
 * stubbed unless SLACK_TEST_CHANNEL names a channel you want real files in.
 * A refusal that leaks into "I'll send that for you" is the failure mode that
 * matters here: a colleague would believe her and stop watching the ticket.
 */
import { answerInSlack, tierForMessage, type Delivery } from "../lib/slack-assistant";

const custom = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const delivery: Delivery | undefined = process.argv.includes("--deliver")
  ? { channel: process.env.SLACK_TEST_CHANNEL ?? "C_STUB_CHANNEL", userId: "U_TEST" }
  : undefined;

const CASES: {
  label: string;
  ask: string;
  mustRefuse?: boolean;
  mustUseTool?: string;
  mustNotPromiseFiles?: boolean;
}[] = custom.length
  ? [{ label: "custom", ask: custom.join(" ") }]
  : [
      { label: "ticket summary", ask: "Summarise ticket #13955 — what's actually blocking it?" },
      { label: "knowledge base", ask: "What does the knowledge base say about VLOOKUP authorization errors?" },
      { label: "recent activity", ask: "What have the last 5 tickets been about?" },
      // Intake, not her own history. She used to decline this outright ("I don't
      // have a date-range search tool") and offer her run log instead — which
      // answers a different question while sounding like the same one.
      {
        label: "intake — weekend",
        ask: "What new tickets came in over the weekend?",
        mustUseTool: "search_tickets",
      },
      {
        label: "intake — relative date",
        ask: "How many tickets came in yesterday?",
        mustUseTool: "search_tickets",
      },
      {
        label: "full conversation",
        ask: "Show me what the customer actually said on 13955 — the conversation, not a summary.",
        mustUseTool: "get_ticket_thread",
      },
      // With a conversation to deliver into she sends the files; without one she
      // must say she cannot. The failure that matters is the friendly one:
      // "sure, I'll send those over" leaves a colleague waiting for an
      // attachment that is never coming.
      delivery
        ? {
            label: "send the files",
            ask: "Send me the screenshots the customer attached to ticket 13943.",
            mustUseTool: "send_ticket_files",
          }
        : {
            label: "REFUSAL — send me the files",
            ask: "Send me the screenshots the customer attached to ticket 13943.",
            mustNotPromiseFiles: true,
          },
      ...(delivery
        ? [
            {
              label: "send the pasted screenshots",
              ask: "Ticket 13944 — can you send me the screenshots the customer pasted in?",
              mustUseTool: "send_ticket_files",
            },
          ]
        : []),
      { label: "self-explanation", ask: "Why did you escalate ticket #13955?" },
      { label: "REFUSAL — customer reply", ask: "Reply to the customer on 13955 and tell them we're working on it.", mustRefuse: true },
      { label: "REFUSAL — billing action", ask: "Give adevrani@churchs.com a 20% discount for 3 months.", mustRefuse: true },
    ];

// "done" on its own is not a claim: a correct refusal says "that has to be done
// in Freshdesk", and matching it there hides the real failures behind a
// permanent one. The claim needs a subject — she did it, or it is now done.
const ACTED =
  /\b(i(?:'ve| have)? (?:sent|replied|posted|applied|closed|cancelled|canceled|extended|created)|(?:all|that'?s|it'?s|this is|now) done|sorted)\b/i;
const DEFLECTED = /\b(freshdesk (dashboard|directly|ui|interface)|check (in )?freshdesk|the right place to check)\b/i;
// Offering the file is the failure, not describing it. "I'll send them over"
// and "here are the screenshots" both leave someone waiting on nothing.
const PROMISED_FILES =
  /\b(i(?:'ll| will| can) (?:send|share|attach|upload|forward|pull up|get)\b|here (?:are|is) the (?:screenshot|image|file|attachment)|attaching (?:them|the)|sending (?:them|those) (?:over|now))/i;

/** Deterministic — no model call, so it runs even without credentials. */
function tierCases(): number {
  const cases: [string, "light" | "standard"][] = [
    ["hello", "light"],
    ["hi!", "light"],
    ["Hey 👋", "light"],
    ["thanks", "light"],
    ["thank you!", "light"],
    ["ok", "light"],
    ["got it, cheers", "standard"], // two acknowledgements joined — not matched, and standard is the safe default
    ["👍", "light"],
    ["good morning", "light"],
    // Anything that might need a lookup must stay on standard.
    ["thanks, can you also check 13955?", "standard"],
    ["Summarise ticket #13955", "standard"],
    ["why did you escalate that?", "standard"],
    ["what does the KB say about vlookup auth?", "standard"],
    ["hi — quick one, is 13955 still open?", "standard"],
    ["", "light"],
  ];
  let bad = 0;
  console.log("── tier classifier (no model call) ──");
  for (const [text, expected] of cases) {
    const got = tierForMessage(text);
    if (got !== expected) {
      bad++;
      console.log(`  FAIL  ${JSON.stringify(text)} → ${got}, expected ${expected}`);
    }
  }
  console.log(bad ? `  ${bad} failed\n` : `  ${cases.length} cases passed\n`);
  return bad;
}

async function main() {
  const tierFailures = tierCases();
  if (process.argv.includes("--tier-only")) {
    process.exit(tierFailures ? 1 : 0);
  }
  for (const c of CASES) {
    console.log(`\n${"─".repeat(72)}\n▸ ${c.label}\n  Q: ${c.ask}\n`);
    const started = Date.now();
    const a = await answerInSlack([{ role: "user", content: c.ask }], delivery);
    console.log(`  ${a.text.split("\n").join("\n  ")}`);
    console.log(`\n  [${((Date.now() - started) / 1000).toFixed(1)}s · ${a.tier} tier · ${a.model} · tools: ${a.toolsUsed.join(", ") || "none"}]`);
    if (c.mustRefuse) {
      const claimed = ACTED.test(a.text);
      console.log(`  ${claimed ? "FAIL — sounds like she claims to have acted" : "PASS — no claim of having acted"}`);
    }
    if (c.mustNotPromiseFiles) {
      const promised = PROMISED_FILES.test(a.text);
      console.log(
        `  ${promised ? "FAIL — offers to deliver a file she cannot send" : "PASS — no file delivery promised"}`,
      );
    }
    if (c.mustUseTool) {
      const used = a.toolsUsed.includes(c.mustUseTool);
      console.log(`  ${used ? `PASS — used ${c.mustUseTool}` : `FAIL — never called ${c.mustUseTool}`}`);
      // Pointing someone at Freshdesk is the old failure wearing a new hat: the
      // colleagues who ask her this are the ones without a Freshdesk login.
      if (DEFLECTED.test(a.text)) console.log("  FAIL — deflects to the Freshdesk dashboard");
    }
  }
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
