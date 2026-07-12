/**
 * Distiller: turn a batch of draft evaluations into candidate Learnings.
 *
 * Pure — takes evaluations + the current learning set in, returns proposals.
 * No storage access, so it is directly testable from a script. The caller
 * (the /api/admin/evals/distill route) applies proposals to the store; every
 * proposal lands as a CANDIDATE that a human must approve in /evals before it
 * affects the system prompt.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { createTwoFilesPatch } from "diff";
import { getModel } from "./llm";
import { EVAL_TAGS, type Learning, type ReplyEvaluation } from "./evals";

export const ProposalSchema = z.object({
  proposals: z.array(
    z.object({
      kind: z
        .enum(["new", "reinforce", "revise"])
        .describe("new = fresh rule; reinforce = an existing learning was confirmed again; revise = an existing learning needs rewording."),
      learningId: z
        .string()
        .optional()
        .describe("Required for reinforce/revise: the [id] of the existing learning."),
      text: z.string().describe("One imperative behavioral rule, ≤200 chars."),
      category: z.enum(EVAL_TAGS),
      product: z.enum(["getsign", "jetpackapps", "all"]),
      sourceEvalIds: z.array(z.string()).describe("Ids of the evaluations that support this proposal."),
      rationale: z.string().describe("One line: what in the feedback justifies this rule."),
    }),
  ),
});

export type Proposal = z.infer<typeof ProposalSchema>["proposals"][number];

const SYSTEM = `You distill reviewer feedback on an AI support agent's reply drafts into short, generalizable guidelines ("learnings") that will be injected into the agent's system prompt.

Rules:
1. Propose a learning ONLY when the feedback reveals a repeatable behavioral rule — tone, policy, escalation judgment, reply structure. Not one-off facts.
2. Product facts and troubleshooting steps belong in the knowledge base, NOT here. Never propose "the fix for X is Y".
3. Each learning is ONE imperative sentence, ≤200 characters. Examples: "Do not offer refunds proactively; only per explicit policy." / "For login/SSO issues, always link the SSO setup doc."
4. Compare against EXISTING LEARNINGS first. If an evaluation confirms one, emit kind "reinforce" with its learningId. If an approved learning needs rewording, emit "revise" with its learningId and the improved text. Never emit a "new" that duplicates or contradicts an existing approved or candidate learning, and never re-propose anything similar to a rejected or retired one.
5. Scope: use product "all" unless the rule is clearly specific to one product.
6. Prefer fewer, stronger learnings. It is fine to propose none.`;

/** Truncate long reply bodies so a batch stays well inside the context. */
function clip(s: string, max = 1200): string {
  return s.length > max ? s.slice(0, max) + "\n…[truncated]" : s;
}

function renderLearning(l: Learning): string {
  return `[${l.id}] (${l.state}, ${l.product}, reinforced x${l.reinforcedCount}) ${l.text}`;
}

function renderEval(e: ReplyEvaluation): string {
  const head = [
    `eval ${e.id}`,
    `subject: ${e.subject ?? `ticket #${e.ticketId}`}`,
    `product: ${e.product}`,
    `outcome: ${e.action} (${e.rating})`,
    e.tags.length ? `tags: ${e.tags.join(", ")}` : null,
    e.note ? `reviewer note: ${e.note}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  if (e.rating === "partial" && e.finalBody) {
    const patch = createTwoFilesPatch(
      "jetta-draft",
      "human-edited",
      e.suggestedReply,
      e.finalBody,
      undefined,
      undefined,
      { context: 2 },
    );
    return `${head}\nedit diff (what the human changed before sending):\n${clip(patch, 2000)}`;
  }
  if (e.rating === "bad") {
    return `${head}\ndiscarded draft:\n${clip(e.suggestedReply)}`;
  }
  return head;
}

/**
 * Distill a batch of evaluations against the current learning set.
 * `good` evaluations are summarized as a count (they mostly drive reinforce);
 * the batch is capped at 25 substantive evaluations per call by the caller.
 */
export async function distillEvaluations(
  evals: ReplyEvaluation[],
  existing: Learning[],
): Promise<Proposal[]> {
  const substantive = evals.filter((e) => e.rating !== "good");
  const goodCount = evals.length - substantive.length;

  const existingBlock = existing.length
    ? existing.map(renderLearning).join("\n")
    : "(none yet)";
  const evalsBlock = substantive.length
    ? substantive.map(renderEval).join("\n\n---\n\n")
    : "(no negative/edited evaluations in this batch)";

  const { object } = await generateObject({
    model: getModel("standard"),
    schema: ProposalSchema,
    system: SYSTEM,
    prompt: `EXISTING LEARNINGS:\n${existingBlock}\n\nEVALUATIONS TO DISTILL (${substantive.length} substantive, plus ${goodCount} approved-as-is):\n\n${evalsBlock}\n\nPropose learnings.`,
  });

  // Drop malformed reinforce/revise proposals that point at nothing.
  const known = new Set(existing.map((l) => l.id));
  return object.proposals.filter(
    (p) => p.kind === "new" || (p.learningId && known.has(p.learningId)),
  );
}
