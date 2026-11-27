/**
 * Does a 👍/👎 on a console assistant answer keep the exchange it rates, and
 * does the rating go on the right line of the transcript?
 *
 *   npx tsx scripts/assistant-feedback-test.ts
 *
 * No network: the store falls back to memory without Redis credentials.
 */
import {
  deleteAssistantFeedback,
  listAssistantFeedback,
  parseAssistantFeedback,
  saveAssistantFeedback,
  setAssistantFeedbackDone,
} from "../lib/assistant-feedback";
import { answerEnds } from "../components/jetta/assistant/rating-snapshot";
import type { TranscriptLine } from "../components/jetta/assistant/live-voice";

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
  // ── which line carries the rating ──────────────────────────────────────
  const lines: TranscriptLine[] = [
    { id: 1, who: "you", text: "What came in yesterday?" },
    { id: 2, who: "jetta", text: "Let me check." },
    { id: 3, who: "tool", text: "Reading today's brief" },
    { id: 4, who: "jetta", text: "Twelve tickets came in." },
    { id: 5, who: "you", text: "Open the first one" },
    { id: 6, who: "tool", text: "Link", links: [{ label: "Ticket #14457", url: "https://x/a/tickets/14457" }] },
    { id: 7, who: "jetta", text: "Here it is", partial: true },
  ];
  const ends = answerEnds(lines);
  check("a rating goes on the last line of an answer, not each line", [...ends.keys()].join() === "4");
  const a = ends.get(4)!;
  check("the snapshot keeps the question", a.question === "What came in yesterday?");
  check("an answer spanning lines is joined", a.answer === "Let me check.\n\nTwelve tickets came in.");
  check("the lookups she ran are kept", a.steps.join() === "Reading today's brief");
  check("a line still being spoken cannot be rated", !ends.has(7));
  const sealed = answerEnds([...lines.slice(0, -1), { ...lines[6], partial: false }]);
  check("once spoken it can", sealed.get(7)?.steps[0] === "Link: Ticket #14457");
  check("she can be rated when she spoke first", answerEnds([{ id: 1, who: "jetta", text: "Hi" }]).get(1)?.question === "");

  // ── what the API accepts ───────────────────────────────────────────────
  const body = {
    id: "k1-4",
    rating: "down",
    reasons: ["wrong", "bogus", "wrong"],
    note: " no ",
    question: "q",
    answer: "a",
    steps: ["s"],
    path: "/today",
    via: "voice",
  };
  const ok = parseAssistantFeedback(body, "suraj", new Date("2026-11-27T10:00:00Z"));
  check("a 👎 is accepted", "entry" in ok);
  if ("entry" in ok) {
    check("unknown and repeated reasons are dropped", ok.entry.reasons.join() === "wrong");
    check("the note is trimmed", ok.entry.note === "no");
    check("the author is the signed-in user, not the body", ok.entry.author === "suraj");
  }
  const up = parseAssistantFeedback({ ...body, rating: "up" }, "suraj");
  check("a 👍 carries no reasons", "entry" in up && up.entry.reasons.length === 0);
  check("a rating needs up or down", "error" in parseAssistantFeedback({ ...body, rating: "meh" }, "s"));
  check("a rating needs the answer", "error" in parseAssistantFeedback({ ...body, answer: " " }, "s"));
  check("an odd id is refused", "error" in parseAssistantFeedback({ ...body, id: "../x" }, "s"));
  const off = parseAssistantFeedback({ ...body, path: "https://evil" }, "s");
  check("a path that is not a console page is dropped", "entry" in off && off.entry.path === undefined);

  // ── the store ──────────────────────────────────────────────────────────
  const base = { reasons: [], question: "q", answer: "a", steps: [] };
  await saveAssistantFeedback({ ...base, id: "1", at: "2026-11-25T10:00:00.000Z", author: "cherryl", rating: "up" });
  await saveAssistantFeedback({ ...base, id: "2", at: "2026-11-26T10:00:00.000Z", author: "sujata", rating: "down" });
  await saveAssistantFeedback({ ...base, id: "3", at: "2026-11-24T10:00:00.000Z", author: "gabriel", rating: "down" });
  check("open 👎 first, newest first", (await listAssistantFeedback()).map((f) => f.id).join() === "2,3,1");
  await setAssistantFeedbackDone("2", true, "suraj");
  check("a handled 👎 drops below the open ones", (await listAssistantFeedback())[0].id === "3");
  await saveAssistantFeedback({ ...base, id: "1", at: "2026-11-25T10:00:00.000Z", author: "cherryl", rating: "down" });
  check("changing your mind overwrites, never duplicates", (await listAssistantFeedback()).length === 3);
  check("someone else cannot take your rating back", !(await deleteAssistantFeedback("1", "sujata")));
  check("you can", await deleteAssistantFeedback("1", "cherryl"));
  check("and it is gone", (await listAssistantFeedback()).length === 2);

  if (failures) {
    console.log(`\n${failures} failed`);
    process.exit(1);
  }
  console.log("\nall passed");
}

main();
