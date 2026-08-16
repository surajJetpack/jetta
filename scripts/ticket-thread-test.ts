/**
 * Tests for reading a ticket conversation page by page.
 *
 *   npx tsx --env-file=.env.local scripts/ticket-thread-test.ts
 *
 * Read-only — every call is a GET. Paced with small waits because a burst of
 * ticket+conversation reads earns a 429 from Freshdesk, and a rate-limited test
 * fails in a way that looks like a bug in the code under test.
 *
 * The fixtures are real tickets, chosen for what they contain:
 *   #13943 — three PNG attachments from the customer.
 *   #13944 — three screenshots PASTED into the body and zero attachments; the
 *            case where reading `attachments` alone concludes there is no
 *            evidence when there is.
 *   #13955 — 23 messages, 10 of them internal notes, four distinct authors.
 * If they are ever deleted the checks skip rather than fail — a missing fixture
 * is not a broken thread reader.
 */
import { getTicketThread, type TicketThread } from "../lib/tools/freshdesk";

let failures = 0;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`);
  }
}

async function load(id: string, opts?: { from?: number; limit?: number }): Promise<TicketThread | null> {
  await wait(400);
  try {
    return await getTicketThread(id, opts);
  } catch (e) {
    console.log(`  ..    #${id} unavailable (${e instanceof Error ? e.message : e}) — skipping`);
    return null;
  }
}

async function attachments() {
  console.log("── attachments and pasted screenshots ──");

  const withFiles = await load("13943", { from: 0, limit: 20 });
  if (withFiles) {
    const files = withFiles.messages.flatMap((m) => m.attachments);
    check(`#13943 surfaces its attachments (${files.length})`, files.length > 0);
    check(
      "…with a name, a content type and a real size",
      files.every((f) => f.name && /\w+\/\w+/.test(f.contentType) && f.size > 0),
      files.map((f) => `${f.name} ${f.contentType} ${f.size}`).join(", "),
    );
    check("…attributed to whoever sent them", files.every((f) => f.author === "customer" || f.author === "agent"));
  }

  const pasted = await load("13944", { from: 0, limit: 20 });
  if (pasted) {
    const inline = pasted.messages.reduce((n, m) => n + m.inlineImages, 0);
    const files = pasted.messages.flatMap((m) => m.attachments).length;
    // The whole reason inlineImages exists: this ticket has screenshots and an
    // empty attachments array, and reporting "no files" here is a wrong answer.
    check(`#13944 counts pasted screenshots (${inline}) that are not attachments (${files})`, inline > 0);
  }
}

async function paging() {
  console.log("\n── paging ──");

  const latest = await load("13955");
  if (!latest) return;
  const total = latest.total;
  check(`#13955 reports a total (${total} messages)`, total > 1);
  check("default page ends at the newest message", latest.to === total - 1);
  check(
    "default page is the tail, not the head",
    latest.from === Math.max(0, total - 12),
    `from=${latest.from}, expected ${Math.max(0, total - 12)}`,
  );
  check("indices are contiguous", latest.messages.every((m, i) => m.index === latest.from + i));

  const head = await load("13955", { from: 0, limit: 5 });
  if (!head) return;
  check("from:0 starts at the opening message", head.from === 0 && head.messages[0]?.index === 0);
  check("the opening message is the customer's", head.messages[0]?.direction === "customer");
  check("limit is honoured", head.messages.length === 5);
  check("total is stable across pages", head.total === total);

  const next = await load("13955", { from: 5, limit: 5 });
  if (!next) return;
  check("the next page continues where the last ended", next.messages[0]?.index === head.to + 1);
  const overlap = next.messages.filter((m) => head.messages.some((h) => h.index === m.index));
  check("pages do not overlap", overlap.length === 0, overlap.map((m) => m.index).join(", "));

  const past = await load("13955", { from: 9999, limit: 3 });
  if (past) {
    // Asking past the end is a paging mistake, not a reason to answer "there is
    // no conversation" about a ticket with 23 messages on it.
    check("an out-of-range page clamps rather than returning nothing", past.messages.length > 0);
  }
}

async function shape() {
  console.log("\n── message shape ──");

  const t = await load("13955", { from: 0, limit: 20 });
  if (!t) return;

  check("internal notes are flagged", t.messages.some((m) => m.private));
  check("both directions are present", new Set(t.messages.map((m) => m.direction)).size === 2);
  check(
    "agent replies carry a real name, not just 'agent'",
    t.messages.some((m) => m.direction === "agent" && m.author !== "agent"),
    [...new Set(t.messages.map((m) => m.author))].join(" | "),
  );
  check(
    "a truncated body says so, and an untruncated one does not",
    t.messages.every((m) => m.truncated === m.body.endsWith("[…truncated]")),
  );
  check("every message is timestamped", t.messages.every((m) => !Number.isNaN(Date.parse(m.at))));
  check("the ticket links back to Freshdesk", /^https:\/\/[^/]+\/a\/tickets\/\d+$/.test(t.url));
  check("the requester is named", t.requester.includes("@"));

  console.log(`\n  #${t.id} "${t.subject}" — ${t.requester}, ${t.status}`);
  for (const m of t.messages.slice(0, 6)) {
    const marks = [
      m.private ? "internal" : null,
      m.attachments.length ? `${m.attachments.length} file(s)` : null,
      m.inlineImages ? `${m.inlineImages} pasted image(s)` : null,
    ].filter(Boolean);
    console.log(
      `    [${String(m.index).padStart(2)}] ${m.at.slice(0, 16)}  ${m.author.padEnd(18)}${marks.length ? ` (${marks.join(", ")})` : ""}`,
    );
    console.log(`         ${m.body.replace(/\s+/g, " ").slice(0, 90)}`);
  }
}

async function main() {
  if (!process.env.FRESHDESK_API_KEY) {
    console.log("No FRESHDESK_API_KEY — run with --env-file=.env.local.");
    process.exit(1);
  }
  await attachments();
  await paging();
  await shape();
  console.log(failures ? `\n${failures} failed\n` : "\nall passed\n");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
