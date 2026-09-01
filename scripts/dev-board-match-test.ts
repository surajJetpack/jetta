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
import { matchDevItem } from "../lib/tools/monday";

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

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
