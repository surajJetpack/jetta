/**
 * Point the escalation store at the threads already in #jetta-escalations.
 *
 * Without this, every ticket that is currently escalated opens one more
 * top-level post before the one-thread-per-ticket rule takes hold — the exact
 * duplicate the fix exists to stop, once per live issue.
 *
 * The mapping is written out rather than scraped so it can be read and argued
 * with. Each ts is the MOST RECENT escalation for that ticket, taken from the
 * channel on 18 Aug 2026: updates should land on the freshest context, and for
 * the tickets that were escalated more than once the older posts are the
 * duplicates we are trying to stop making.
 *
 *   npx tsx --env-file=.env.local scripts/backfill-escalation-threads.ts
 *   npx tsx --env-file=.env.local scripts/backfill-escalation-threads.ts --commit
 */
export {};

/** ticket/conversation id → Slack ts of its live escalation. */
const THREADS: { ticketId: string; ts: string; what: string }[] = [
  { ticketId: "13955", ts: "1787000157.828269", what: "VLOOKUP · churchstexas bulk management (18 Aug)" },
  { ticketId: "13900", ts: "1786969784.536729", what: "VLOOKUP · Copy & Sync setup error (17 Aug)" },
  { ticketId: "13901", ts: "1786965669.584199", what: "GetSign · R2L quote colon + currency symbol (17 Aug)" },
  { ticketId: "13995", ts: "1786897760.826569", what: "VLOOKUP · reports success, column stays empty (16 Aug)" },
  { ticketId: "13915", ts: "1786734038.992289", what: "Smart Columns · duplicate auto-numbers (15 Aug)" },
  { ticketId: "13947", ts: "1786582863.976409", what: "Extract · Outlook link menu closes instantly (13 Aug)" },
  { ticketId: "13941", ts: "1786558049.367469", what: "GetSign · StandWithUs quota / credit-back (12 Aug)" },
  { ticketId: "13894", ts: "1786542114.719969", what: "TrackMy · Excel import doesn't fire automation (12 Aug)" },
  { ticketId: "13919", ts: "1786538932.457769", what: "VLOOKUP · bulk sync skips specific items (12 Aug)" },
  { ticketId: "13944", ts: "1786473329.048359", what: "GetSign · dropdown options empty when sent (12 Aug)" },
  { ticketId: "13924", ts: "1785956107.997199", what: "GetSign · Next does nothing on multi-doc (6 Aug)" },
  { ticketId: "13895", ts: "1785848876.179029", what: "GetSign · recipients cannot enter a signature (4 Aug)" },
  // JettaChat: the conversation id is the ticket id on that channel.
  {
    ticketId: "5268029a-85f1-4a94-833e-88d516dcb99a",
    ts: "1786760683.536639",
    what: "TrackMy · blank pages, chat #5268029a (15 Aug)",
  },
];

async function main() {
  const commit = process.argv.includes("--commit");
  const force = process.argv.includes("--force");
  const { config } = await import("../lib/config");
  if (!config.kv.url) {
    console.error("No KV credentials — run with --env-file=.env.local.");
    process.exit(1);
  }
  const { getEscalationTs, recordEscalation } = await import("../lib/kv");

  console.log(
    `${commit ? "Writing" : "Dry run (pass --commit to write)"} — ${THREADS.length} escalation threads\n`,
  );
  let written = 0;
  let skipped = 0;
  for (const { ticketId, ts, what } of THREADS) {
    const existing = await getEscalationTs(ticketId);
    if (!force) {
      // Anything already in the store was written by a live run, which knows
      // better than a hand-written table does.
      if (existing && existing !== ts) {
        console.log(`  skip  ${ticketId.padEnd(38)} already points at ${existing} — ${what}`);
        skipped++;
        continue;
      }
      if (existing === ts) {
        console.log(`  same  ${ticketId.padEnd(38)} ${ts} — ${what}`);
        skipped++;
        continue;
      }
    }
    if (commit) await recordEscalation(ticketId, ts);
    console.log(`  ${commit ? " set" : "would"}  ${ticketId.padEnd(38)} ${ts} — ${what}`);
    written++;
  }
  console.log(`\n${commit ? "Wrote" : "Would write"} ${written}, skipped ${skipped}.`);
  if (!commit) console.log("Nothing was written. Re-run with --commit.");
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.stack : e);
  process.exit(1);
});
