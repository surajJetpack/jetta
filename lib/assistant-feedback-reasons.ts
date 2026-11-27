/** Why an answer got 👎. Its own module so the browser can import it without the Redis store. */
export const ASSISTANT_FEEDBACK_REASONS = {
  wrong: "Wrong answer",
  outdated: "Out of date",
  not_found: "Couldn't find it",
  wrong_page: "Took me to the wrong page",
} as const;
export type AssistantFeedbackReason = keyof typeof ASSISTANT_FEEDBACK_REASONS;
