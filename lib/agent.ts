/**
 * The agent loop, built on the AI SDK's `generateText`.
 *
 * Provider-agnostic: the model comes from `getModel()` (Gemini in dev, Claude
 * in production per the spec). `generateText` runs the multi-step tool loop —
 * each step the model either calls a tool (which we execute) or emits the final
 * text. `stopWhen: stepCountIs(maxSteps)` bounds it.
 *
 * Tool execution happens inside the AI SDK via each tool's `execute`. We read
 * the shared `signals` object afterwards to learn whether a resolution was
 * logged (→ schedule the 24h follow-up).
 */
import { generateText, stepCountIs, type ModelMessage } from "ai";
import { config } from "./config";
import { getModel } from "./llm";
import type { ConversationContext } from "./types";
import { buildTools, type AgentSignals } from "./tools";

/** One executed tool call, for display/auditing. */
export interface TraceEntry {
  tool: string;
  input: unknown;
  result: string;
}

export interface AgentResult {
  /** Final natural-language text from Jetta. */
  text: string;
  /** True if a tool logged a resolution, signalling a 24h follow-up. */
  resolutionSent: boolean;
  /** Names of tools executed, in order. */
  toolsUsed: string[];
  /** Full per-call trace (tool, input, result). */
  trace: TraceEntry[];
}

export interface RunOptions {
  /** Preview mode: read tools run, but mutating tools make no external call. */
  dryRun?: boolean;
}

export async function runAgentLoop(
  system: string,
  messages: ModelMessage[],
  ctx: ConversationContext,
  opts: RunOptions = {},
): Promise<AgentResult> {
  const signals: AgentSignals = { resolutionSent: false };

  const result = await generateText({
    model: getModel(),
    system,
    messages,
    tools: buildTools(ctx, signals, { dryRun: opts.dryRun }),
    stopWhen: stepCountIs(config.llm.maxSteps),
  });

  const trace: TraceEntry[] = [];
  for (const step of result.steps) {
    for (const call of step.toolCalls) {
      const match = step.toolResults.find((r) => r.toolCallId === call.toolCallId);
      const output = match ? (match as { output?: unknown }).output : undefined;
      trace.push({
        tool: call.toolName,
        input: call.input,
        result: typeof output === "string" ? output : JSON.stringify(output ?? ""),
      });
    }
  }

  return {
    text: result.text.trim(),
    resolutionSent: signals.resolutionSent,
    toolsUsed: trace.map((t) => t.tool),
    trace,
  };
}
