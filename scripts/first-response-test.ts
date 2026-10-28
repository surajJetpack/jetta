/**
 * Contract test for Jetta's first response (lib/first-response.ts).
 *   npx tsx --env-file=.env.local scripts/first-response-test.ts [--live]
 *
 * Part 1 (deterministic, always runs): eligibility, hard checks, sign-off,
 * markdown → Freshdesk HTML, send-time decisions, delay window.
 * Part 2 (--live, needs LLM keys): the model gate on a few hand-made cases.
 */
import {
  firstResponseEligibility,
  hardBlock,
  humanize,
  judgeFirstResponse,
  pickDelayMs,
  sendDecision,
  stripSignOff,
  withSignOff,
} from "../lib/first-response";
import { markdownToFdHtml } from "../lib/tools/freshdesk";
import type { Ticket } from "../lib/types";

function ticket(partial: Partial<Ticket>): Ticket {
  return {
    id: "test",
    subject: "Workflow using 2 credits",
    description: "One document with two signers uses 2 credits. Why?",
    status: "Open",
    requesterName: "Mike Rta",
    requesterEmail: "mike@example.com",
    replies: [],
    source: 1,
    tags: [],
    hasPublicAgentReply: false,
    ...partial,
  };
}

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${name}${ok || detail === undefined ? "" : ` — got ${JSON.stringify(detail)}`}`);
}
const reason = (e: ReturnType<typeof firstResponseEligibility>) => (e.eligible ? "eligible" : e.reason);

async function main() {
  console.log("── eligibility ──");
  const fd = (t: Partial<Ticket>) => reason(firstResponseEligibility({ channel: "freshdesk", ticket: ticket(t) }));
  check("email, unanswered → eligible", fd({}) === "eligible", fd({}));
  check("portal → eligible", fd({ source: 2 }) === "eligible");
  check("in-app form (source 3) → eligible", fd({ source: 3 }) === "eligible");
  check("feedback widget → eligible", fd({ source: 9 }) === "eligible");
  check("CHAT ticket (source 7) → from_chat", fd({ source: 7 }) === "from_chat", fd({ source: 7 }));
  check("outbound (10) → not eligible", fd({ source: 10 }) === "source_10");
  check("unknown source → not eligible", fd({ source: null }) === "source_unknown");
  check("an agent already replied → already_answered", fd({ hasPublicAgentReply: true }) === "already_answered");
  check("reply status unknown → already_answered (fail safe)", fd({ hasPublicAgentReply: undefined }) === "already_answered");
  check("jetta-hold tag → hold_tag", fd({ tags: ["VIP", "Jetta-Hold"] }) === "hold_tag");
  check(
    "jettachat channel → not_freshdesk",
    reason(firstResponseEligibility({ channel: "jettachat", ticket: ticket({}) })) === "not_freshdesk",
  );

  console.log("── hard checks ──");
  const good =
    "Hi Mike,\n\nEach signer on a document uses one credit, so a document with two signers uses two. That's expected rather than a fault.\n\nIf the count still looks off on a document with a single signer, send me its name and I'll take a look.";
  check("clean reply passes", hardBlock(good) === null, hardBlock(good));
  check("too short", hardBlock("Hi, thanks!") === "too_short");
  check("FD link blocked", hardBlock(`${good}\nhttps://jetpackapps.freshdesk.com/a/tickets/14535`) === "internal_link");
  const ours = { mondayHost: "jetpackteam.monday.com", boardIds: ["2978633042"] };
  check("our dev board link blocked", hardBlock(`${good}\nhttps://x.monday.com/boards/2978633042/pulses/1`, ours) === "internal_link");
  check("our monday account blocked", hardBlock(`${good}\nhttps://jetpackteam.monday.com/boards/1`, ours) === "internal_link");
  check("customer's own board link allowed", hardBlock(`${good}\nhttps://bullionsharks.monday.com/boards/6352458365`, ours) === null);
  check("ticket number blocked", hardBlock(`${good}\nYour ticket #14535 is with us.`) === "ticket_number");
  check("placeholder blocked", hardBlock(`Hi [Customer Name],\n\n${good}`) === "placeholder");
  check("markdown link is not a placeholder", hardBlock(`${good}\nSee [link to the guide](https://getsign.io/help).`) === null);
  check("AI self-reference blocked", hardBlock(`${good}\nAs an AI, I can't see your board.`) === "self_reference");
  check("internal detail blocked", hardBlock(`${good}\nI've added it to the dev board.`) === "internal_detail");
  check("our logs blocked", hardBlock(`${good}\nThe engineering team has an answer from the logs.`) === "internal_detail");
  check("stored token blocked", hardBlock(`${good}\nThe stored token lost write access.`) === "internal_detail");
  check("customer's API token allowed", hardBlock(`${good}\nPaste your monday API token into the settings.`) === null);
  check("customer's activity log allowed", hardBlock(`${good}\nCheck the board's Activity Log for the change.`) === null);
  check("admission blocked", hardBlock(`${good}\nYou were right to insist on a real answer.`) === "admission");
  check("plain apology allowed", hardBlock(`${good}\nI'm sorry for the trouble this caused.`) === null);

  console.log("── sign-off ──");
  check("strips 'Best,\\nJetta'", stripSignOff(`${good}\n\nBest,\nJetta`) === good);
  check("strips 'Kind regards,\\nJetta\\nJetpack Apps Support'", stripSignOff(`${good}\n\nKind regards,\nJetta\nJetpack Apps Support`) === good);
  check("keeps a closing sentence that isn't a sign-off", stripSignOff(`${good}\n\nThanks for the screenshot, it helped a lot.`).endsWith("helped a lot."));
  const signed = withSignOff(`${good}\n\nCheers,\nJetta`, "GetSign");
  check("exactly one sign-off, ours", signed.endsWith("Best,\nJetta\nGetSign Support") && signed.split("Jetta").length === 2, signed.slice(-60));

  console.log("── humanize ──");
  check("'Hi Admin,' → 'Hi,'", humanize("Hi Admin,\n\nThe fields are opaque now.", "Admin").startsWith("Hi,\n\nThe fields"));
  check("real name kept", humanize("Hi Dan,\n\nOk.", "Dan Smith").startsWith("Hi Dan,"));
  check("email-as-name → 'Hi,'", humanize("Hi ops@acme.com,\n\nOk.", "ops@acme.com").startsWith("Hi,"), humanize("Hi ops@acme.com,\n\nOk.", "ops@acme.com"));
  const fl = humanize("Hi Ryan,\n\nThanks for getting in touch. That's a great question about how our plans work. Monthly lets you change each month.\n\nWe'll be in touch shortly.", "Ryan");
  check("filler sentences removed, content kept", fl === "Hi Ryan,\n\nMonthly lets you change each month.", fl);
  check("list left alone", humanize("Steps:\n1. Great question.\n2. Go.", null) === "Steps:\n1. Great question.\n2. Go.");
  // A "." with no space after it is not a sentence end. The old splitter
  // dropped every clause before one.
  const dom = "Hi Sam,\n\nPlease invite support@jetpackwork.com to your monday.com board. Version 2.5 fixed it.";
  check("domains, emails and decimals keep their sentence", humanize(dom, "Sam") === dom, humanize(dom, "Sam"));
  const mixed = humanize("Hi Sam,\n\nThanks for reaching out. Open monday.com and pick the board.", "Sam");
  check("filler still removed next to a domain", mixed === "Hi Sam,\n\nOpen monday.com and pick the board.", mixed);

  console.log("── markdown → Freshdesk HTML ──");
  const html = markdownToFdHtml(
    "Hi Mike,\n\nTry this:\n1. Open **Settings**\n2. Click [Billing](https://getsign.io/billing)\n\nMore at https://getsign.io/help.\nThanks\n\n- one\n- two <b>",
  );
  check("paragraphs", html.startsWith("<p>Hi Mike,</p>"), html);
  check("numbered list", html.includes("<ol><li>Open <strong>Settings</strong></li><li>Click <a href=\"https://getsign.io/billing\">Billing</a></li></ol>"), html);
  check("bare URL linked, trailing period kept outside", html.includes('<a href="https://getsign.io/help">https://getsign.io/help</a>.<br>Thanks'), html);
  check("bullets + escaping", html.includes("<ul><li>one</li><li>two &lt;b&gt;</li></ul>"), html);
  check("no literal ** left", !html.includes("**"));

  console.log("── send-time decision ──");
  const job = { answersMessageAt: "" };
  const d = (t: Ticket | null, terminal = false) => {
    const r = sendDecision(job, t, terminal);
    return r.action === "send" ? "send" : r.reason;
  };
  check("untouched → send", d(ticket({})) === "send");
  check("ticket gone → not_found", d(null) === "not_found");
  check("teammate replied → answered", d(ticket({ hasPublicAgentReply: true })) === "answered");
  check("hold tag added → hold_tag", d(ticket({ tags: ["jetta-hold"] })) === "hold_tag");
  check("closed → closed", d(ticket({}), true) === "closed");
  check(
    "customer wrote again → customer_wrote_again",
    d(ticket({ replies: [{ author: "customer", authorEmail: null, body: "also…", createdAt: "2026-10-12T10:00:00Z", isPrivate: false }] })) ===
      "customer_wrote_again",
  );
  check(
    "a private note doesn't count as the customer writing",
    d(ticket({ replies: [{ author: "agent", authorEmail: null, body: "note", createdAt: "2026-10-12T10:00:00Z", isPrivate: true }] })) === "send",
  );

  console.log("── delay ──");
  check("low end", pickDelayMs([3, 7], () => 0) === 180_000);
  check("high end", pickDelayMs([3, 7], () => 1) === 420_000);

  if (process.argv.includes("--live")) {
    console.log("── model gate (live) ──");
    const trace = (kb: string) => [
      { tool: "search_knowledge_base", input: { keyword: "credits per signer" }, result: kb },
    ];
    const kb = JSON.stringify([{ title: "How credits work", body: "Each signer on a document consumes one credit. A document sent to two signers uses two credits." }]);
    const cases: { name: string; t: Ticket; reply: string; expect: boolean }[] = [
      { name: "grounded answer → send", t: ticket({}), reply: good, expect: true },
      {
        name: "invented fact → hold",
        t: ticket({}),
        reply: "Hi Mike,\n\nThis is a known bug in version 4.2 and it will be fixed by Friday. We've refunded the extra credit to your account.",
        expect: false,
      },
      {
        name: "chargeback threat → hold",
        t: ticket({ description: "You double-charged me. If this isn't refunded today I'm filing a chargeback with my bank and contacting my lawyer." }),
        reply: "Hi Mike,\n\nI'm sorry about the double charge. I've passed this to our billing team, who will look at your invoices and get back to you.",
        expect: false,
      },
      {
        name: "honest holding reply on refund request → send",
        t: ticket({ subject: "Prorated refund", description: "We upgraded but the app glitches. Can we get a prorated refund?" }),
        reply: "Hi Mike,\n\nSorry the app hasn't been behaving since you upgraded. I've passed your refund request to our billing team, and they'll reply here.\n\nSo we can fix the glitches too, could you tell me what you see when it goes wrong — a screenshot would be ideal?",
        expect: true,
      },
      {
        name: "asks for a call → hold (needs a person)",
        t: ticket({ subject: "change", description: "Hi there has been a recent change in our GetSign, can I schedule for help asap.. Thanks, Paul" }),
        reply: "Hi Paul,\n\nCould you tell me what changed — is something no longer working, or does it look different? A screenshot would help me point you the right way.",
        expect: process.env.JETTA_BOOKING_URL ? true : false,
      },
      {
        name: "nonprofit pricing talk → hold (sales)",
        t: ticket({ subject: "Pricing package", description: "Impressed with GetSign so far and would like to discuss pricing. We are a charity in the UK." }),
        reply: "Hi Louisa,\n\nGlad GetSign is working well for you. Our plans start at $25 a month on annual billing. Which features matter most to you?",
        expect: false,
      },
    ];
    // Saying a request was passed on is a claim like any other: it needs the
    // escalation in the evidence, and the refund case carries one.
    const runs = Number(process.env.GATE_RUNS ?? 1);
    for (const c of cases) for (let i = 0; i < runs; i++) {
      const v = await judgeFirstResponse(
        c.t,
        c.reply,
        {
          trace: c.name.includes("refund")
            ? [{ tool: "send_escalation", input: { headline: "Prorated refund request after upgrade" }, result: "Escalation posted to the dev team (ts 1)." }]
            : c.name.includes("chargeback")
              ? []
              : trace(kb),
        },
        "GetSign",
      );
      check(`${c.name} (${v.risk}: ${v.reason})`, v.send === c.expect);
    }
  }

  console.log(failed ? `\n${failed} FAILED` : "\nall passed");
  process.exit(failed ? 1 : 0);
}

main();
