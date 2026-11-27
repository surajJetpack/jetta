/**
 * Does a run leave one short note on the ticket instead of several long ones?
 *
 *   npx tsx scripts/run-notes-test.ts
 *
 * No network: Freshdesk is not live in tests, so note writes only log.
 */
import { buildTools, type AgentSignals } from "../lib/tools/index";
import { detectHandoff } from "../lib/performance";
import {
  chatRelayHtml,
  clipNote,
  contextHtml,
  dropRepeatedMatches,
  NOTE_LIMIT,
  postRunNotes,
  supersededHtml,
  takeRunNotes,
} from "../lib/run-notes";
import type { AgentResult } from "../lib/agent";
import type { ConversationContext } from "../lib/types";

export {};

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok    ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`);
  }
}

async function main() {
  // ── clipping ───────────────────────────────────────────────────────────
  check("a short note is left alone", clipNote("Escalated to the team.") === "Escalated to the team.");
  const long = clipNote("word ".repeat(400));
  check("a long note is clipped near the limit and says so", long.length < NOTE_LIMIT + 60 && long.endsWith("(full note in the run log)"));

  // ── repeated dev-board matches ─────────────────────────────────────────
  const earlier = ["Strong match on Dev board: item 13625564077 (Template editor times out)."];
  const notes = [
    "Strong match found on Dev board: https://x.monday.com/boards/1/pulses/13625564077",
    "Strong match on Dev board: item 99999999999 (something new).",
    "Added +1 to existing Dev board item 13625564077 for this customer.",
    "Escalated to team via Slack. Renewal in 2 days.",
  ];
  const kept = dropRepeatedMatches(notes, earlier);
  check("a match already noted on the ticket is dropped", !kept.includes(notes[0]!));
  check("a match to a new item is kept", kept.includes(notes[1]!));
  check("a note that also did something is kept", kept.includes(notes[2]!) && kept.includes(notes[3]!));
  check("the same match twice in one run is noted once", dropRepeatedMatches([notes[1]!, notes[1]!], []).length === 1);

  // ── the note shapes ────────────────────────────────────────────────────
  check("the context block is headed and escaped", contextHtml(["a <b> c"]).startsWith("<p><b>What Jetta did</b></p>") && contextHtml(["a <b> c"]).includes("&lt;b&gt;"));
  check("no notes, no block", contextHtml([]) === "");
  check("a replaced suggestion keeps the prefix stats read", supersededHtml(1_795_700_000).startsWith("<p><b>Jetta — suggested reply (replaced)"));
  const relay = chatRelayHtml(["10:01 UTC: uses Safari", "10:05 UTC: it's urgent"], "https://c/chats/1");
  check("the chat note lists each update once, with the link", relay.split("<li>").length === 3 && relay.includes("https://c/chats/1"));

  // ── add_private_note holds in draft mode ───────────────────────────────
  const ctx = { channel: "freshdesk", ticket: { id: "14850", replies: [] } } as unknown as ConversationContext;
  const signals: AgentSignals = { resolutionSent: false };
  const tools = buildTools(ctx, signals, { holdCustomerWrites: true, holdNotes: true });
  const run = (tools.add_private_note as unknown as { execute: (i: unknown) => Promise<string> }).execute;
  const said = await run({ body: "Escalated to team via Slack." });
  check("the model is told the note was added", said === "Private note added.");
  check("the note is held, not posted", signals.notes?.join() === "Escalated to team via Slack.");

  // ── handing them on ────────────────────────────────────────────────────
  const result = { pendingNotes: ["one", "two"] } as AgentResult;
  check("taking the notes empties them", takeRunNotes(result).join() === "one,two" && result.pendingNotes!.length === 0);
  await postRunNotes("14850", result);
  check("nothing left, nothing posted twice", result.pendingNotes!.length === 0);

  // ── stats still see hand-offs folded into a suggestion ─────────────────
  const folded = detectHandoff([
    {
      private: true,
      incoming: false,
      created_at: "2026-11-27T10:00:00Z",
      body_text: "Jetta — suggested reply (pending) Hi Saminda, I've escalated this. What Jetta did Created dev board item https://x/pulses/13625564077",
    },
  ]);
  check("a dev item filed in the context block still counts", !!folded?.kinds.includes("dev_item") && folded.itemIds.includes("13625564077"));
  const replyOnly = detectHandoff([
    { private: true, incoming: false, created_at: "2026-11-27T10:00:00Z", body_text: "Jetta — suggested reply (pending) We created dev board item for you" },
  ]);
  check("the reply text itself still does not count", replyOnly === null);

  if (failures) {
    console.log(`\n${failures} failed`);
    process.exit(1);
  }
  console.log("\nall passed");
}

main();
