/**
 * Blind quality judge for reconciled drafts.
 *
 * Reconciliation tells us whether Jetta's draft was used. It cannot tell us
 * whether it was any good — the human's reply is not automatically better. The
 * retrospective human benchmark had Jetta ahead 25/3/1 on first responses, so
 * treating every divergence as a Jetta failure would teach her to imitate replies
 * that are often worse.
 *
 * Two stages, because they have different requirements:
 *  1. WHICH is better — must be blind, and the presentation order alternates,
 *     since a judge always shown the same position develops a position bias.
 *  2. WHY they diverged — only asked when Jetta lost (the only case where the
 *     reason changes anything) and deliberately NOT blind, so the taxonomy can
 *     name the two replies directly instead of guessing at scrambled labels.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { config } from "./config";
import { EVAL_TAGS, type EvalTag } from "./evals";

/**
 * The judge must NOT be the model that wrote the drafts.
 *
 * LLM judges reliably prefer their own output, and production drafts are written
 * by the standard tier (z-ai/glm-5.2 today). Judging with getModel("standard")
 * would grade Jetta's homework with Jetta's own handwriting — a first pass that
 * way returned "human better: 0%", which is not a believable number. Sonnet 5 is
 * the same independent judge scripts/human-benchmark.ts uses, so verdicts stay
 * comparable with that benchmark.
 */
const JUDGE_MODEL = "anthropic/claude-sonnet-5";

function judgeModel() {
  if (!config.openrouter.apiKey) throw new Error("OPENROUTER_API_KEY is not set (needed for the judge).");
  return createOpenRouter({ apiKey: config.openrouter.apiKey }).chat(JUDGE_MODEL);
}

/**
 * Why the two replies differed. The first three are Jetta's to fix. The rest are
 * not: an agent who already fixed the problem, or who knows something internal,
 * teaches nothing a prompt change could use.
 */
export const DIVERGENCE_REASONS = [
  "jetta_too_long",
  "jetta_punted",
  "jetta_wrong_or_incomplete",
  "human_had_internal_knowledge",
  "human_took_an_action",
  "other",
] as const;
export type DivergenceReason = (typeof DIVERGENCE_REASONS)[number];

/** Reasons worth feeding the distiller — the rest are context, not lessons. */
const LEARNABLE: ReadonlySet<DivergenceReason> = new Set([
  "jetta_too_long",
  "jetta_punted",
  "jetta_wrong_or_incomplete",
]);

export interface Judgement {
  winner: "jetta" | "human" | "tie";
  /** Only meaningful when the human won; "other" otherwise. */
  reason: DivergenceReason;
  tags: EvalTag[];
  explanation: string;
  /** True when this should shape the system prompt. */
  learnable: boolean;
}

const BLIND_SYSTEM = `You compare two candidate support replies to the same customer message and decide which better serves the customer.

You are NOT told who wrote either reply. Do not guess or speculate about authorship — judge only the text.

Judge on: does it answer what was actually asked, is it accurate and specific, is it the right length for that question, does it move the ticket forward, and is the tone right for a paying customer.

A short reply that fully answers beats a long one that hedges. A long reply that explains something genuinely complex beats a terse one that leaves the customer stuck. Padding, throat-clearing, and "I'm looking into it" with no substance are weaknesses. So is a reply that ignores part of the question.

Choose "equal" only when you genuinely cannot separate them.`;

const REASON_SYSTEM = `An AI support agent drafted a reply. A human agent sent a different reply instead, and the human's was judged better. Classify the single main reason the AI's draft fell short:

- "jetta_too_long" — the draft was materially more verbose than the question needed
- "jetta_punted" — the draft deferred ("checking with the team", "I'll follow up") where an answer was possible
- "jetta_wrong_or_incomplete" — the draft was factually wrong, missed the question, or omitted something important
- "human_had_internal_knowledge" — the human's reply relied on information not visible in the ticket (internal state, prior context, account specifics the AI could not have known)
- "human_took_an_action" — the human reported having already done something (a fix, a config change, a removal)
- "other" — none of the above

Be honest about the last three: if the human simply knew or did something the AI had no access to, say so. Do not manufacture a fault in the draft.`;

/**
 * Stage 1: which reply is better, judged blind.
 * `jettaFirst` is caller-supplied so ordering can be alternated deterministically.
 */
async function judgeWinner(input: {
  customerMessage: string;
  jettaReply: string;
  humanReply: string;
  jettaFirst: boolean;
}): Promise<{ winner: Judgement["winner"]; tags: EvalTag[]; explanation: string }> {
  const { object } = await generateObject({
    model: judgeModel(),
    schema: z.object({
      better: z.enum(["REPLY_A", "REPLY_B", "equal"]),
      // No .max(): Anthropic's structured-output schema rejects maxItems.
      tags: z.array(z.enum(EVAL_TAGS)),
      explanation: z.string(),
    }),
    system: BLIND_SYSTEM,
    prompt:
      `CUSTOMER MESSAGE:\n"""\n${input.customerMessage.slice(0, 3000)}\n"""\n\n` +
      `REPLY_A:\n"""\n${(input.jettaFirst ? input.jettaReply : input.humanReply).slice(0, 3000)}\n"""\n\n` +
      `REPLY_B:\n"""\n${(input.jettaFirst ? input.humanReply : input.jettaReply).slice(0, 3000)}\n"""\n\n` +
      `Which better serves the customer?`,
  });

  const winner: Judgement["winner"] =
    object.better === "equal"
      ? "tie"
      : (object.better === "REPLY_A") === input.jettaFirst
        ? "jetta"
        : "human";
  return { winner, tags: object.tags, explanation: object.explanation };
}

/**
 * Stage 2: why the two replies differed.
 *
 * Called automatically when the human won, and exported so it can be run over
 * ALL diverged pairs as a diagnostic — the reason is the interesting part even
 * when the judge scored the draft higher, because "the human took an action" and
 * "the human knew something internal" describe gaps no prompt change can close.
 */
export async function classifyDivergence(input: {
  customerMessage: string;
  jettaReply: string;
  humanReply: string;
}): Promise<DivergenceReason> {
  const { object } = await generateObject({
    model: judgeModel(),
    schema: z.object({ reason: z.enum(DIVERGENCE_REASONS) }),
    system: REASON_SYSTEM,
    prompt:
      `CUSTOMER MESSAGE:\n"""\n${input.customerMessage.slice(0, 3000)}\n"""\n\n` +
      `AI DRAFT:\n"""\n${input.jettaReply.slice(0, 3000)}\n"""\n\n` +
      `HUMAN REPLY (judged better):\n"""\n${input.humanReply.slice(0, 3000)}\n"""`,
  });
  return object.reason;
}

export async function judgeDraftPair(input: {
  customerMessage: string;
  jettaReply: string;
  humanReply: string;
  jettaFirst: boolean;
}): Promise<Judgement> {
  const { winner, tags, explanation } = await judgeWinner(input);
  if (winner !== "human") {
    return { winner, reason: "other", tags, explanation, learnable: false };
  }
  const reason = await classifyDivergence(input);
  return { winner, reason, tags, explanation, learnable: LEARNABLE.has(reason) };
}
