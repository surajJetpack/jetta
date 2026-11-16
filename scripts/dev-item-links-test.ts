/**
 * Is a dev item still recognised as its ticket's item once the update that
 * said so has scrolled out of view? No network, no model.
 *
 *   npx tsx scripts/dev-item-links-test.ts
 *
 * The ticket link is in the item's OLDEST update; every read takes the newest
 * few. This script builds an item with more comments than the window and
 * checks that the stored link (lib/dev-item-links.ts) keeps it attached — and
 * that a link is learned the first time an item is read while its filing
 * update can still be seen.
 */
export {};

process.env.STUB_MODE = "true";
for (const v of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_URL"]) {
  delete process.env[v];
}

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${!ok && detail ? `\n        ${detail}` : ""}`);
}
const section = (name: string) => console.log(`\n── ${name} ──`);

async function main() {
  const links = await import("../lib/dev-item-links");
  const { itemCarriesTicket, ticketIdsOnItem, JETTA_POST_PREFIX } = await import("../lib/tools/monday");

  const context = { text_body: "Product: getsign\nAccount: https://acme.monday.com\nFreshdesk ticket: https://x.freshdesk.com/a/tickets/14600\n\nError: the sync stops" };
  const chatter = (n: number) => Array.from({ length: n }, (_, i) => ({ text_body: `${JETTA_POST_PREFIX} update ${i}` }));
  // Newest first, as monday returns them: the filing context is last.
  const young = { id: "9001", column_values: [], updates: [...chatter(5), context] };
  // The same item 25 comments later, read through a 20-update window: the context is gone.
  const aged = { id: "9001", column_values: [], updates: chatter(20) };

  section("The problem");
  check("while the filing update is in view, the item carries its ticket", itemCarriesTicket(young, "14600"));
  check("once it has scrolled out, the row alone no longer does", !itemCarriesTicket(aged, "14600") && ticketIdsOnItem(aged).length === 0);

  section("Learning and applying, pure");
  check("the filing ticket is read from Jetta's context post", links.filedForTicket(young) === "14600");
  check(
    "a ticket a developer merely pasted is not \"filed for\"",
    links.filedForTicket({ updates: [{ text_body: "same as https://x.freshdesk.com/a/tickets/14400" }] }) === null,
  );
  check(
    "the ORIGINAL filing wins over a later follow-up from another ticket",
    links.filedForTicket({
      updates: [
        { text_body: "Follow-up from the SAME Freshdesk ticket — added here.\n\nProduct: getsign\nFreshdesk ticket: https://x/a/tickets/14999" },
        context,
      ],
    }) === "14600",
  );
  const learned = links.applyLinks([young], new Map());
  check("an unseen item with its context in view is learned", learned.learned.length === 1 && learned.learned[0].join() === "9001,14600");
  check("…and its row is left as monday gave it", learned.rows[0] === young);
  const applied = links.applyLinks([aged], new Map([["9001", "14600"]]));
  check("a stored link puts the ticket back on a row that has lost it", itemCarriesTicket(applied.rows[0], "14600"));
  check("…as the ticket it was filed FOR, first in the list", ticketIdsOnItem(applied.rows[0])[0] === "14600");
  check("…without matching a longer ticket number", !itemCarriesTicket(applied.rows[0], "1460") && !itemCarriesTicket(applied.rows[0], "146000"));
  check("…and nothing is re-learned for it", applied.learned.length === 0);
  check("an item nobody filed from a ticket is untouched", links.applyLinks([{ id: "9002", column_values: [], updates: chatter(3) }], new Map()).rows[0].column_values?.length === 0);

  section("Through the store");
  links.resetItemTicketsForTest();
  check("nothing is remembered to begin with", (await links.itemTickets()).size === 0);
  const firstRead = await links.withStoredLinks([young]);
  check("reading an item with its context in view remembers the link", (await links.itemTickets()).get("9001") === "14600");
  check("…and that first read is unchanged", firstRead[0] === young);
  const laterRead = await links.withStoredLinks([aged]);
  check("a later read, context gone, still finds the ticket", itemCarriesTicket(laterRead[0], "14600") && ticketIdsOnItem(laterRead[0]).join() === "14600");
  await links.rememberItemTicket("9003", "15001");
  check("a link stored at filing time works with no update read at all", itemCarriesTicket((await links.withStoredLinks([{ id: "9003", column_values: [], updates: [] }]))[0], "15001"));
  links.setLinksReadOnly(true);
  await links.withStoredLinks([{ id: "9010", column_values: [], updates: [context] }]);
  await links.rememberItemTicket("9011", "15010");
  check("read-only mode stores nothing", !(await links.itemTickets()).has("9010") && !(await links.itemTickets()).has("9011"));
  check("…and reports what it withheld", links.withheldLinks().map((p) => p.join(":")).join() === "9010:14600,9011:15010", links.withheldLinks().join(" "));
  links.setLinksReadOnly(false);
  await links.rememberItemTicket("9004", null);
  await links.rememberItemTicket("not-an-id", "15002");
  await links.rememberItemTicket("9005", "/tickets/15003");
  check("a missing or malformed id is not stored", (await links.itemTickets()).size === 2, [...(await links.itemTickets()).entries()].join(" "));
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} FAILED` : "\nall passed");
    process.exit(failures ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
