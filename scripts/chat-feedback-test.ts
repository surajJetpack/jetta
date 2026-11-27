/**
 * Does a 👍/👎 on a Jetta chat reply rate the right message and quote what
 * the customer really said?
 *
 *   npx tsx scripts/chat-feedback-test.ts
 *
 * No network: the store falls back to memory without Redis credentials.
 */
import {
  chatFeedbackFor,
  chatFeedbackId,
  deleteChatFeedback,
  listChatFeedback,
  parseChatRating,
  replyContext,
  saveChatFeedback,
  setChatFeedbackDone,
  type ChatFeedback,
} from "../lib/chat-feedback";

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
  // ── which reply, and what came before it ───────────────────────────────
  const msgs = [
    { id: "a", author: "agent" as const, via: "jetta" as const, text: "Hi! How can I help?" },
    { id: "b", author: "visitor" as const, text: "My signature box is missing" },
    { id: "c", author: "visitor" as const, text: "on the PDF" },
    { id: "s", author: "agent" as const, system: true, text: "Jetta is looking into it" },
    { id: "d", author: "agent" as const, via: "jetta" as const, text: "Open the template and add a Signature field." },
    { id: "e", author: "agent" as const, via: "human" as const, text: "Hi, Sujata here" },
  ];
  const d = replyContext(msgs, "d");
  check(
    "the customer's messages since her last reply are kept, system lines skipped",
    d?.customer === "My signature box is missing\non the PDF",
  );
  check("the reply is quoted as sent", d?.reply === "Open the template and add a Signature field.");
  check("her opening line has no customer message", replyContext(msgs, "a")?.customer === "");
  check("a teammate's message cannot be rated", replyContext(msgs, "e") === null);
  check("a customer's message cannot be rated", replyContext(msgs, "b") === null);
  check("a system line cannot be rated", replyContext(msgs, "s") === null);
  check("an unknown message cannot be rated", replyContext(msgs, "zz") === null);

  // ── what the API accepts ───────────────────────────────────────────────
  const conv = "3f2b1c9e-1111-4222-8333-444455556666";
  const p = parseChatRating({ conversationId: conv, messageId: "d", rating: "down", reasons: ["ticket", "nope", "ticket"], note: " x " });
  check(
    "a 👎 with reasons is accepted, unknown and repeated reasons dropped",
    "rating" in p && p.reasons.join() === "ticket" && p.note === "x",
  );
  const up = parseChatRating({ conversationId: conv, messageId: "d", rating: "up", reasons: ["long"] });
  check("a 👍 carries no reasons", "rating" in up && up.reasons.length === 0);
  check("a rating must be up or down", "error" in parseChatRating({ conversationId: conv, messageId: "d", rating: "ok" }));
  check("odd ids are refused", "error" in parseChatRating({ conversationId: "a:b", messageId: "d", rating: "up" }));

  // ── the store ──────────────────────────────────────────────────────────
  const base = (author: string, rating: "up" | "down", at: string, conversationId = conv): ChatFeedback => ({
    id: chatFeedbackId(conversationId, "d", author),
    conversationId,
    messageId: "d",
    at,
    author,
    rating,
    reasons: [],
    customer: "q",
    reply: "a",
  });
  await saveChatFeedback(base("sujata", "down", "2026-11-26T10:00:00.000Z"));
  await saveChatFeedback(base("cherryl", "up", "2026-11-27T10:00:00.000Z"));
  await saveChatFeedback(base("gabriel", "down", "2026-11-25T10:00:00.000Z", "other"));
  check("two colleagues can rate the same reply differently", (await chatFeedbackFor(conv)).length === 2);
  await saveChatFeedback(base("sujata", "up", "2026-11-27T11:00:00.000Z"));
  check("changing your mind overwrites, never duplicates", (await chatFeedbackFor(conv)).length === 2);
  check("open 👎 first", (await listChatFeedback())[0]!.author === "gabriel");
  await setChatFeedbackDone(chatFeedbackId("other", "d", "gabriel"), true, "suraj");
  check("a handled 👎 drops below", (await listChatFeedback())[0]!.author !== "gabriel");
  await deleteChatFeedback(chatFeedbackId(conv, "d", "cherryl"));
  check("taking a rating back removes only yours", (await chatFeedbackFor(conv)).map((f) => f.author).join() === "sujata");

  if (failures) {
    console.log(`\n${failures} failed`);
    process.exit(1);
  }
  console.log("\nall passed");
}

main();
