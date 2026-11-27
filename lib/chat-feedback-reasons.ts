/** Why a Jetta chat reply got 👎. Its own module so the browser can import it without the Redis store. */
export const CHAT_FEEDBACK_REASONS = {
  wrong: "Wrong or made-up answer",
  ticket: "Should have opened a ticket",
  long: "Too long",
  tone: "Wrong tone",
} as const;
export type ChatFeedbackReason = keyof typeof CHAT_FEEDBACK_REASONS;
