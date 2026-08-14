/**
 * Do monday ids in escalation prose come out clickable?
 *
 *   npx tsx scripts/slack-linkify-test.ts
 *
 * The cases are real sentences copied out of #jetta-escalations, where the ids
 * were plain digits nobody could click. Deterministic — no network, no LLM.
 *
 * The half that matters most is what must NOT be linked: a board id guessed
 * against the wrong monday account is worse than the plain number, because it
 * looks authoritative and lands the reader in someone else's workspace.
 */
import { linkifyMondayIds, devItemIdsIn } from "../lib/tools/slack";

const DEV_BOARD = "2978633042";
const OURS = "https://jetpackteam.monday.com";
const CUSTOMER = "https://churchstexas.monday.com";

let failed = 0;
function check(label: string, actual: string, expected: string) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) {
    console.log(`        expected: ${expected}`);
    console.log(`        actual:   ${actual}`);
  }
}

console.log("\n── our dev board items ──");
check(
  "dev board item <id>",
  linkifyMondayIds("Is this the same root cause as dev board item 11735712226, or separate?", {
    devBoardId: DEV_BOARD,
  }),
  `Is this the same root cause as dev board item <${OURS}/boards/${DEV_BOARD}/pulses/11735712226|11735712226>, or separate?`,
);
check(
  'dev board item "Title" (<id>) — the form the model actually favours',
  linkifyMondayIds('the open Dev board item "TrackMy not updating after bulk update" (12757964338), which I have +1d', {
    devBoardId: DEV_BOARD,
  }),
  // The author's parentheses survive — the rewrite links the id in place
  // rather than restructuring the sentence around it.
  `the open Dev board item "TrackMy not updating after bulk update" (<${OURS}/boards/${DEV_BOARD}/pulses/12757964338|12757964338>), which I have +1d`,
);
check(
  "dev board item: Unquoted Title (<id>)",
  linkifyMondayIds("Added +1 to existing dev board item: VLookUp Template not working (11735712226).", {
    devBoardId: DEV_BOARD,
  }),
  `Added +1 to existing dev board item: VLookUp Template not working (<${OURS}/boards/${DEV_BOARD}/pulses/11735712226|11735712226>).`,
);
check(
  "an unquoted run-on that mentions a board is NOT claimed as an item",
  linkifyMondayIds(`Account ${CUSTOMER}. The dev item helped, but source board (5850411194) still fails.`, {
    devBoardId: DEV_BOARD,
  }),
  `Account ${CUSTOMER}. The dev item helped, but source board (<${CUSTOMER}/boards/5850411194|5850411194>) still fails.`,
);
check(
  "no dev board configured → left alone",
  linkifyMondayIds("see dev board item 11735712226", {}),
  "see dev board item 11735712226",
);

console.log("\n── the customer's boards ──");
check(
  "board id links to the account named in the same escalation",
  linkifyMondayIds(
    `Account: ${CUSTOMER}. Can the team review the webhook creation failure on source board 5850411194?`,
    { devBoardId: DEV_BOARD },
  ),
  `Account: ${CUSTOMER}. Can the team review the webhook creation failure on source board <${CUSTOMER}/boards/5850411194|5850411194>?`,
);
check(
  "NO account anywhere → left as plain text rather than guessed",
  linkifyMondayIds("webhooks are not being created on the source board 5850411194", {
    devBoardId: DEV_BOARD,
  }),
  "webhooks are not being created on the source board 5850411194",
);
check(
  "our dev item appearing FIRST does not hijack the customer's board link",
  // Regression: escalations lead with the dev item, so the first monday URL in
  // the text is ours. Taking it unfiltered sent the customer's board id to our
  // own workspace.
  linkifyMondayIds(
    `*Dev board item:* <${OURS}/boards/${DEV_BOARD}/pulses/12790471510>\nwebhooks not created on the source board (5850411194). Account is <http://churchstexas.monday.com|churchstexas.monday.com>`,
    { devBoardId: DEV_BOARD, accountUrl: `<${OURS}/boards/${DEV_BOARD}/pulses/12790471510> <http://churchstexas.monday.com|churchstexas.monday.com>` },
  ),
  `*Dev board item:* <${OURS}/boards/${DEV_BOARD}/pulses/12790471510>\nwebhooks not created on the source board (<${CUSTOMER}/boards/5850411194|5850411194>). Account is <http://churchstexas.monday.com|churchstexas.monday.com>`,
);
check(
  "our own account in the text is not mistaken for the customer's",
  linkifyMondayIds(`Dev item at ${OURS}/boards/${DEV_BOARD}/pulses/1 — check source board 5850411194`, {
    devBoardId: DEV_BOARD,
  }),
  `Dev item at ${OURS}/boards/${DEV_BOARD}/pulses/1 — check source board 5850411194`,
);
check(
  "our dev board id in prose stays on our account",
  linkifyMondayIds(`Account ${CUSTOMER}. Filed on board ${DEV_BOARD}.`, { devBoardId: DEV_BOARD }),
  `Account ${CUSTOMER}. Filed on board <${OURS}/boards/${DEV_BOARD}|${DEV_BOARD}>.`,
);

check(
  '"Target board is <id>" — a connecting word must not block the link',
  linkifyMondayIds(`Account ${CUSTOMER}. Target board is 9787413360.`, { devBoardId: DEV_BOARD }),
  `Account ${CUSTOMER}. Target board is <${CUSTOMER}/boards/9787413360|9787413360>.`,
);

check(
  "Slack bold markers between the label and the id do not block the match",
  // Verbatim from a real DM answer, where this silently linked nothing.
  linkifyMondayIds(
    `*Source board:* 5850411194\n*Account:* <http://churchstexas.monday.com|churchstexas.monday.com>`,
    { devBoardId: DEV_BOARD },
  ),
  `*Source board:* <${CUSTOMER}/boards/5850411194|5850411194>\n*Account:* <http://churchstexas.monday.com|churchstexas.monday.com>`,
);
check(
  "…and for dev items too",
  linkifyMondayIds("*Dev item:* 12790471510", { devBoardId: DEV_BOARD }),
  `*Dev item:* <${OURS}/boards/${DEV_BOARD}/pulses/12790471510|12790471510>`,
);

console.log("\n── per-item board lookup (Slack DMs, where the product is unknown) ──");
check(
  "an item on the GetSign board links to the GetSign board, not the default",
  linkifyMondayIds("see dev board item 999888777", { devBoardId: (id) => (id === "999888777" ? "3713478000" : undefined) }),
  `see dev board item <${OURS}/boards/3713478000/pulses/999888777|999888777>`,
);
check(
  "an id the lookup could not place stays plain rather than guessing a board",
  linkifyMondayIds("see dev board item 111222333", { devBoardId: () => undefined }),
  "see dev board item 111222333",
);
check(
  "devItemIdsIn finds every id needing a lookup",
  // Order is irrelevant — the result feeds a map lookup, not a list anyone reads.
  JSON.stringify(devItemIdsIn('dev board item 11735712226 and Dev board item "T" (12757964338)').sort()),
  JSON.stringify(["11735712226", "12757964338"].sort()),
);

console.log("\n── things that must be left exactly as they are ──");
check(
  "an existing Slack link is not linked a second time",
  linkifyMondayIds(`Dev board item: <${OURS}/boards/${DEV_BOARD}/pulses/12790471510>`, {
    devBoardId: DEV_BOARD,
  }),
  `Dev board item: <${OURS}/boards/${DEV_BOARD}/pulses/12790471510>`,
);
check(
  "a labelled Slack link survives untouched",
  linkifyMondayIds(`<https://jetpackwork.freshdesk.com/a/tickets/13955|#13955> · board 5850411194 · ${CUSTOMER}`, {
    devBoardId: DEV_BOARD,
  }),
  `<https://jetpackwork.freshdesk.com/a/tickets/13955|#13955> · board <${CUSTOMER}/boards/5850411194|5850411194> · ${CUSTOMER}`,
);
check(
  "mailto links are untouched",
  linkifyMondayIds("<mailto:adevrani@churchs.com|adevrani@churchs.com> reported it", { devBoardId: DEV_BOARD }),
  "<mailto:adevrani@churchs.com|adevrani@churchs.com> reported it",
);
check(
  "a ticket number is not a monday id",
  linkifyMondayIds(`Account ${CUSTOMER}. Ticket #13955 about board sync`, { devBoardId: DEV_BOARD }),
  `Account ${CUSTOMER}. Ticket #13955 about board sync`,
);
check(
  "short numbers are never ids",
  linkifyMondayIds(`Account ${CUSTOMER}. 400 docs/mo on board 12345`, { devBoardId: DEV_BOARD }),
  `Account ${CUSTOMER}. 400 docs/mo on board 12345`,
);
check(
  "prose with no ids is returned unchanged",
  linkifyMondayIds("Force Update is unresponsive and the recipe recreation only helps briefly.", {
    devBoardId: DEV_BOARD,
  }),
  "Force Update is unresponsive and the recipe recreation only helps briefly.",
);

console.log(failed ? `\n${failed} FAILED\n` : "\nall checks passed\n");
process.exit(failed ? 1 : 0);
