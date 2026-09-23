/**
 * Does the dev-board matcher only claim a match when there IS one?
 *
 *   npx tsx scripts/dev-board-match-test.ts
 *
 * No network, no model, no board: `matchDevItem` is pure, and these are the
 * cases that decide whether a customer's bug report gets filed or quietly
 * attached to somebody else's item.
 *
 * The rule this suite defends: a hit needs real overlap AND at least two
 * distinctive words in common, and only a genuine issue — not a wish on the
 * backlog — can be "strong". The matcher it replaced kept anything sharing one
 * token longer than two characters, which on the real boards returned five
 * confident "matches" for "Billing: I was charged twice this month".
 *
 * Titles below are real rows from the two boards, so the thresholds are tuned
 * against what people actually write, not against invented examples.
 */
import {
  devItemUpdateText,
  freshdeskTicketId,
  itemCarriesTicket,
  matchDevItem,
} from "../lib/tools/monday";

export {};

let failures = 0;

function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`);
  }
}

const FIELD = "Client reported Field Issues";

/** Same bug, different words — must be strong. */
const SAME: [string, { title: string; body?: string; group?: string }][] = [
  [
    "Generate Link function isn't working",
    { title: "Generate Link function isn't working", group: FIELD },
  ],
  [
    "Failed to send document for signature",
    { title: "GetSign – Failed to send document for signature", group: FIELD },
  ],
  [
    "Custom Item ID smart column is generating duplicate IDs again",
    { title: "Custom Item ID Smart Column generating duplicate IDs despite prior fix", group: "Bugs and Field Issues" },
  ],
  [
    // The title says almost nothing; the description carries the detail.
    "signed documents never arrive in the board file column",
    {
      title: "Sync problem",
      body: "Signed documents never arrive in the file column on the board after the last signer completes.",
      group: FIELD,
    },
  ],
];

/** Different problems that share generic words — must not match at all. */
const DIFFERENT: [string, { title: string; body?: string; group?: string }][] = [
  [
    "Billing: I was charged twice this month",
    { title: "When an update is created using email, and has attachments", group: "Feature Enhancements" },
  ],
  [
    "How do I add a column to my board?",
    { title: "Changing How -to use links for all Smart Columns", group: "Feature Enhancements" },
  ],
  [
    "Signature request email never arrives for one recipient",
    { title: "Need to change email content and download issue for manual recipients", group: "Internal Bug" },
  ],
  [
    "TrackMy stopped updating tracking numbers after bulk upload",
    { title: "TrackMy - Ocean container tracking research", group: "Coming Up" },
  ],
  [
    // One shared distinctive word is a coincidence, whatever else lines up.
    "webhook registration races the recipe save",
    { title: "Webhook", group: FIELD },
  ],
];

console.log("\nThe same bug, said differently");
for (const [symptom, item] of SAME) {
  const m = matchDevItem(symptom, item);
  check(
    `strong: "${symptom.slice(0, 46)}"`,
    m?.confidence === "strong",
    m ? `scored ${m.score} (${m.confidence}), ${m.shared} shared terms` : "no match at all",
  );
}

console.log("\nDifferent problems that share generic words");
for (const [symptom, item] of DIFFERENT) {
  const m = matchDevItem(symptom, item);
  check(
    `no match: "${symptom.slice(0, 46)}"`,
    m === null,
    m ? `matched "${item.title}" at ${m.score} (${m.confidence})` : undefined,
  );
}

console.log("\nA wish is never a duplicate of a fault");
{
  const item = { title: "As a user I would like to send document for approval", group: "Backlog" };
  const m = matchDevItem("Failed to send document for approval", item);
  check("a backlog row scores…", (m?.score ?? 0) >= 0.65, `scored ${m?.score ?? 0}`);
  check("…but is capped at possible", m?.confidence === "possible", `got ${m?.confidence}`);
  const asBug = matchDevItem("Failed to send document for approval", { ...item, group: FIELD });
  check("…and the identical row in a bug group is strong", asBug?.confidence === "strong");
}

console.log("\nToo little to go on");
{
  check("a one-word symptom matches nothing", matchDevItem("sync", { title: "Sync problem", group: FIELD }) === null);
  check(
    "a symptom of nothing but filler matches nothing",
    matchDevItem("it is not working please help", { title: "Not working", group: FIELD }) === null,
  );
  check("an empty symptom matches nothing", matchDevItem("", { title: "Anything", group: FIELD }) === null);
}

/*
 * Ticket 14331, the pair that made this section exist.
 *
 * A chat-born ticket was worked twice, 29 minutes apart, and the second run
 * filed a second item for the same report. It had FOUND the first one — and
 * scored it 0.62, one notch under "strong", because the GetSign board has no
 * long_text or text column, so every word Jetta writes about a bug lives in an
 * update and the matcher was reading titles alone.
 */
const TICKET_14331_SUBJECT = "Change default signing link expiration from 24 hours to no expiry";
const ITEM_13028129994 = {
  title: "No KB documentation for configuring default signing link expiration",
  update: [
    "Product: getsign",
    "Account: (no linked billing account)",
    "Freshdesk ticket: https://jetpackwork.freshdesk.com/a/tickets/14331",
    "",
    "Error: Customer uses GetSign at the item level on a monday.com board. Signing links expire within 24 hours by default. Customer wants to change the default so links do not expire unless an expiration date is explicitly set.",
    "",
    "Reproduction steps:",
    "1. Open GetSign in item view on a monday.com board. 2. Generate a signing link. 3. Observe the link expires after 24 hours.",
  ].join("\n"),
};

console.log("\nAn item's update text counts as its description");
{
  const titleOnly = matchDevItem(TICKET_14331_SUBJECT, {
    title: ITEM_13028129994.title,
    group: FIELD,
  });
  check(
    "title alone is only 'possible' — the gap that duplicated ticket 14331",
    titleOnly?.confidence === "possible",
    `scored ${titleOnly?.score ?? 0} (${titleOnly?.confidence ?? "no match"})`,
  );

  const withUpdate = matchDevItem(TICKET_14331_SUBJECT, {
    title: ITEM_13028129994.title,
    body: devItemUpdateText(ITEM_13028129994.update),
    group: FIELD,
  });
  check(
    "…and with the update read, the same pair is strong",
    withUpdate?.confidence === "strong",
    `scored ${withUpdate?.score ?? 0} (${withUpdate?.confidence ?? "no match"})`,
  );
}

console.log("\nUpdate boilerplate votes for nothing");
{
  const stripped = devItemUpdateText(ITEM_13028129994.update);
  check("the Product/Account/ticket header is gone", !/Product:|Account:|Freshdesk ticket:/.test(stripped), stripped.slice(0, 80));
  check("the ticket URL is gone", !/https?:\/\//.test(stripped));
  check("the Error: and Reproduction steps: labels are gone", !/Error:|Reproduction steps:/.test(stripped));
  check("…but what they introduced is kept", /signing links expire within 24 hours/i.test(stripped));

  // Every item Jetta files carries that header. If it survived, a symptom
  // using its words would score against the whole board at once.
  const boilerplateOnly = matchDevItem("product account conversation surface reproduction steps", {
    title: "Something else entirely",
    body: devItemUpdateText(ITEM_13028129994.update),
    group: FIELD,
  });
  check("a symptom made of header words matches nothing", boilerplateOnly === null, `got ${JSON.stringify(boilerplateOnly)}`);
}

console.log("\nA two-word symptom is a lead, never a verdict");
{
  // Real pair from the Dev Tasks board. "vlookup" is in the title, "question"
  // turns up somewhere in the comment thread, and that used to be enough to
  // score 0.75 — i.e. to stop a customer's bug being filed at all.
  const m = matchDevItem("VLookUp questions", {
    title: "VLookUp Template not working",
    body: "Customer had a question about the template.",
    group: "Bugs and Field Issues",
  });
  check("it can still surface as a lead", m !== null, "matched nothing at all");
  check("…but never as the same bug", m?.confidence === "possible", `got ${m?.confidence} at ${m?.score}`);
  check(
    "one more distinctive word and it can be strong again",
    matchDevItem("VLookUp template questions", {
      title: "VLookUp Template not working",
      body: "Customer had a question about the template.",
      group: "Bugs and Field Issues",
    })?.confidence === "strong",
  );
}

console.log("\nOne item per Freshdesk ticket");
{
  const item = { updates: [{ text_body: ITEM_13028129994.update }] };
  check("the id comes out of a ticket URL", freshdeskTicketId("https://jetpackwork.freshdesk.com/a/tickets/14331") === "14331");
  check("…and is null when there is no ticket", freshdeskTicketId("(no ticket)") === null);
  check("an item filed for this ticket is recognised", itemCarriesTicket(item, "14331"));
  check("a shorter id does not match a longer one", !itemCarriesTicket(item, "1433"));
  check("a different ticket does not match", !itemCarriesTicket(item, "14332"));
  check(
    "the link is read where a column holds it too",
    itemCarriesTicket({ column_values: [{ text: "https://jetpackwork.freshdesk.com/a/tickets/14331" }] }, "14331"),
  );
  check("an item with nothing on it carries no ticket", !itemCarriesTicket({}, "14331"));
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
