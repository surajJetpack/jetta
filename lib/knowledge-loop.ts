/**
 * Knowledge Loop: turn a resolved escalation thread into a draft KB article.
 *
 * A dev resolves an escalation in #jetta-escalations; Jetta reads the thread and
 * drafts a concise support article. The draft is posted back in the thread for a
 * human to review — it is NEVER published to the KB without explicit approval.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { getModel } from "./llm";

export const DraftSchema = z.object({
  title: z.string().describe("Concise, support-oriented article title."),
  body: z
    .string()
    .describe("The fix/answer as clear steps or explanation. Only what the thread supports."),
  keywords: z.array(z.string()).describe("6-15 lowercase search terms a user might type."),
});

export type KbDraft = z.infer<typeof DraftSchema>;

const SYSTEM = `You write internal support knowledge-base articles for the GetSign / Jetpack Apps support agent.

You are given a support escalation thread where the dev/support team provided the resolution. Distil it into a reusable KB article so the agent can resolve the same issue next time.

Rules:
- Use ONLY facts present in the thread. Do not invent steps, causes, or product behaviour.
- Write the body as the customer-facing fix or answer (steps or explanation), neutral and reusable — not "the dev said…".
- Do not include internal-only details (engineer names, internal ticket IDs, code internals, infrastructure) in the body.
- If the thread does not contain an actual resolution, produce a title noting that and an empty-ish body saying the resolution was not captured.
- Keep it concise and factual.`;

export async function draftKbArticle(threadText: string): Promise<KbDraft> {
  const { object } = await generateObject({
    model: getModel(),
    schema: DraftSchema,
    system: SYSTEM,
    prompt: `Escalation thread (oldest to newest):\n\n${threadText}\n\nDraft the KB article.`,
  });
  return object;
}
