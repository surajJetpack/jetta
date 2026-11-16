/**
 * One-off backfill: remember which Freshdesk ticket each live dev item was
 * filed for (lib/dev-item-links.ts).
 *
 * New items are remembered when they are filed, and existing ones are learned
 * the first time they are read while their filing update is still among the
 * newest. This is for the ones that are ALREADY past that point: items with so
 * many comments that the update naming their ticket has left every read
 * window, so today nothing recognises them as that ticket's item.
 *
 * It looks at every item in a live group of both dev boards that currently
 * shows no ticket, reads its updates all the way back, and stores the link if
 * Jetta's filing context is there. Items filed by hand have none and are
 * listed as such.
 *
 * DRY RUN BY DEFAULT — prints what it would store and writes nothing. That
 * takes a switch (`setLinksReadOnly`): merely listing the live items learns
 * the links that are in view, and without it the "dry" run stored those.
 *
 *   npx tsx --env-file=.env.local scripts/backfill-dev-item-links.ts
 *   npx tsx --env-file=.env.local scripts/backfill-dev-item-links.ts --commit
 *
 * Reads monday only (one to a few queries per unlinked item, paced). Safe to
 * run twice.
 */
import { config } from "../lib/config";
import { filingTicketByPaging, liveItemIds } from "../lib/tools/monday";
import { itemTickets, rememberItemTicket, setLinksReadOnly, withheldLinks } from "../lib/dev-item-links";

const COMMIT = process.argv.includes("--commit");

async function main() {
  if (!config.monday.live || !config.monday.apiToken) {
    console.error("monday is not connected — run with --env-file=.env.local.");
    process.exit(1);
  }
  if (!COMMIT) setLinksReadOnly(true);
  const before = await itemTickets();
  const items = await liveItemIds();
  const inView = withheldLinks();
  const unlinked = items.filter((i) => !i.ticketIds.length);
  console.log(`${items.length} live items, ${items.length - unlinked.length} already show a ticket, ${before.size} links stored.`);
  if (!COMMIT) {
    console.log(`${inView.length} of those have their filing update in view and no stored link yet; the app learns these on its own the next time it reads them.`);
  }
  console.log(`Reading back through ${unlinked.length} item(s) with no ticket in view…\n`);

  let found = 0;
  for (const item of unlinked) {
    const ticket = await filingTicketByPaging(item.id).catch((e) => {
      console.log(`  ${item.id}  error: ${e instanceof Error ? e.message : e}`);
      return null;
    });
    if (ticket) {
      found++;
      console.log(`  ${item.id}  → ticket ${ticket}  (${item.group})${COMMIT ? "  stored" : ""}`);
      if (COMMIT) await rememberItemTicket(item.id, ticket);
    } else {
      console.log(`  ${item.id}  no filing context (${item.group})`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(
    found
      ? `\n${found} link(s) ${COMMIT ? "stored" : "found — re-run with --commit to store them"}.`
      : "\nNothing to backfill: no live item has lost a ticket link.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
