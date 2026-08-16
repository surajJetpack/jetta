/**
 * Does a dev board search report the status the board actually holds?
 *
 *   npx tsx --env-file=.env.local scripts/dev-board-status-test.ts
 *
 * Read-only — searches only, no writes (unlike scripts/monday-search.ts, which
 * posts a +1). This exists because the field was hardcoded: `status: "open"`
 * for every item, on both boards, forever. Nothing failed, no error was logged,
 * and the value arrived in the ticket agent's prompt and in Slack answers
 * looking exactly like the facts around it that were true.
 *
 * The trap the fix has to keep clearing: both boards carry FOUR status-type
 * columns — Dev Status, Project, Priority, Type — so taking "the first status
 * column" yields a project name ("VLOOKUP") rather than progress.
 */
import { searchDevBoard } from "../lib/tools/monday";
import type { Product } from "../lib/types";

let failures = 0;

function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`);
  }
}

const PROBES: { symptom: string; product: Product }[] = [
  { symptom: "vlookup template not working", product: "jetpackapps" },
  { symptom: "signing flow monday api", product: "getsign" },
  { symptom: "signed document syncing", product: "getsign" },
];

/** Values of the OTHER status columns, which must never be mistaken for progress. */
const NOT_PROGRESS = /^(vlookup|getsign|trackmy|signature flows|high|medium|low|bug|feature enhancements)$/i;

async function main() {
  if (!process.env.MONDAY_API_TOKEN) {
    console.log("No MONDAY_API_TOKEN — run with --env-file=.env.local.");
    process.exit(1);
  }

  const seen: string[] = [];
  for (const { symptom, product } of PROBES) {
    const items = await searchDevBoard(symptom, product);
    console.log(`\n"${symptom}" (${product}) — ${items.length} hits`);
    for (const i of items) console.log(`   [${i.status}] ${i.title.slice(0, 55)}`);
    if (!items.length) continue;
    seen.push(...items.map((i) => i.status));

    check(
      `${product}: every hit carries a status`,
      items.every((i) => i.status.trim().length > 0),
    );
    // The old hardcoded value. If it ever comes back it will come back as
    // exactly this string, on every item at once.
    check(
      `${product}: nothing reports the literal "open"`,
      items.every((i) => i.status !== "open"),
    );
    check(
      `${product}: no project, priority or type leaked in as progress`,
      items.every((i) => !NOT_PROGRESS.test(i.status)),
      items.map((i) => i.status).join(", "),
    );
    // Assignee comes from a column literally titled "Developer  ↗️" on one
    // board, so an exact title match returns nobody for every item on it.
    check(
      `${product}: at least one item names who has it`,
      items.some((i) => i.assignee),
      items.map((i) => `${i.id}:${i.assignee ?? "—"}`).join(", "),
    );
    check(
      `${product}: an assignee is a name, not a status value`,
      items.every((i) => !i.assignee || !NOT_PROGRESS.test(i.assignee)),
    );
    check(
      `${product}: last-updated stamps parse as dates`,
      items.every((i) => !i.updatedAt || !Number.isNaN(Date.parse(i.updatedAt))),
      items.map((i) => i.updatedAt ?? "—").join(", "),
    );
  }

  check("statuses vary across items, rather than one value for everything", new Set(seen).size > 1, seen.join(", "));
  check(
    "at least one resolved to a real board value, not 'unknown'",
    seen.some((s) => s !== "unknown"),
  );

  const distribution = [...new Set(seen)].map((s) => `${s} × ${seen.filter((x) => x === s).length}`);
  console.log(`\n  statuses seen: ${distribution.join(", ")}`);
  console.log(failures ? `\n${failures} failed\n` : "\nall passed\n");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
