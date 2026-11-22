/**
 * Is a comment that starts with "Jetta feedback:" kept as feedback, and is
 * every other comment left to the dev bridge?
 *
 *   npx tsx scripts/feedback-test.ts
 *
 * No network: the opener is a pure function and the store falls back to
 * memory without Redis credentials.
 */
import { feedbackText, listFeedback, saveFeedback, setFeedbackDone } from "../lib/feedback";

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
  check("the opener is recognised", feedbackText("Jetta feedback: summarise the logs") === "summarise the logs");
  check("case and spacing do not matter", feedbackText("  JETTA  Feedback - too many posts") === "too many posts");
  check("a tag before it is fine", feedbackText("@Suraj Malla Jetta feedback: drop Sentry") === "drop Sentry");
  check('"feedback for Jetta:" works too', feedbackText("Feedback for Jetta: good summary") === "good summary");
  check("later lines are kept", feedbackText("Jetta feedback: one\ntwo") === "one\ntwo");
  check("a sentence that mentions feedback is not an entry", feedbackText("Jetta feedback was useful here") === null);
  check("feedback named mid-comment is not an entry", feedbackText("Fixed it. Jetta feedback: none") === null);
  check("an ordinary developer question is not an entry", feedbackText("@Suraj Malla which account is this?") === null);
  check("an opener with nothing after it is not an entry", feedbackText("Jetta feedback:") === null);
  check("a long preamble before the opener is not a tag", feedbackText(`@Suraj ${"x".repeat(60)} Jetta feedback: a`) === null);

  await saveFeedback({ id: "1", at: "2026-11-20T10:00:00.000Z", author: "Swejal", itemId: "10", text: "older" });
  await saveFeedback({ id: "2", at: "2026-11-21T10:00:00.000Z", author: "Cherryl", itemId: "11", text: "newer" });
  check("newest first", (await listFeedback()).map((f) => f.id).join() === "2,1");
  await saveFeedback({ id: "2", at: "2026-11-21T10:00:00.000Z", author: "Cherryl", itemId: "11", text: "newer" });
  check("a redelivered comment is stored once", (await listFeedback()).length === 2);
  const done = await setFeedbackDone("2", true, "suraj");
  check("handled records who and when", done?.doneBy === "suraj" && !!done.doneAt);
  check("handled entries sink below open ones", (await listFeedback()).map((f) => f.id).join() === "1,2");
  const reopened = await setFeedbackDone("2", false, "suraj");
  check("opening again clears it", !reopened?.doneAt && !reopened?.doneBy);
  check("an unknown id is refused", (await setFeedbackDone("nope", true, "suraj")) === null);

  if (failures) {
    console.log(`\n${failures} failed`);
    process.exit(1);
  }
  console.log("\nall passed");
}
void main();
