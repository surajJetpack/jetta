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
import { config, type ModelTier } from "./config";
import { getModel, modelLabel } from "./llm";
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
  /** The dry-run mode actually used (may be forced on by the allowlist). */
  dryRun: boolean;
  /** True if a live run was downgraded to dry-run because the ticket isn't allowlisted. */
  blockedByAllowlist: boolean;
  /** True if customer-visible writes (reply/close) were held for human approval. */
  heldCustomerWrites: boolean;
  /** Aggregate token usage across the loop. */
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  /** Label of the model that actually ran this loop (provider/model-id). */
  model: string;
}

/** Live writes allowed only when the allowlist is empty (no restriction) or the ticket is on it. */
function liveWritesAllowed(ticketId: string | undefined): boolean {
  const list = config.ticketAllowlist;
  if (list.length === 0) return true;
  return !!ticketId && list.includes(ticketId);
}

export interface RunOptions {
  /** Preview mode: read tools run, but mutating tools make no external call. */
  dryRun?: boolean;
  /**
   * Draft mode: internal tools run live, but customer-visible writes
   * (reply_to_ticket, close_ticket) are recorded in the trace without sending —
   * a human approves them later. Held runs bypass the ticket allowlist (nothing
   * customer-visible can go out autonomously).
   */
  holdCustomerWrites?: boolean;
  /** Explicit model tier for this run (console A/B override). Wins over autoTier. */
  tier?: ModelTier;
  /**
   * Opt in to complexity-based routing: when JETTA_TIERED_AGENT=true and the
   * ticket triaged "simple", the run uses the light tier. Off by default.
   */
  autoTier?: boolean;
}

/** Resolve which tier a run should use. Fails toward "standard". */
function resolveTier(ctx: ConversationContext, opts: RunOptions): ModelTier {
  if (opts.tier) return opts.tier;
  if (opts.autoTier && config.llm.tieredAgent && ctx.complexity === "simple") return "light";
  return "standard";
}

export async function runAgentLoop(
  system: string,
  messages: ModelMessage[],
  ctx: ConversationContext,
  opts: RunOptions = {},
): Promise<AgentResult> {
  const signals: AgentSignals = { resolutionSent: false };

  // Allowlist guard: a requested live run is forced to dry-run unless the ticket
  // is allowlisted. Dry-run requests pass through unchanged. Held runs (draft
  // mode) are never forced dry — customer writes are already held, and internal
  // actions are meant to run live for every ticket.
  const allowed = liveWritesAllowed(ctx.ticket?.id);
  const hold = opts.holdCustomerWrites === true;
  const blockedByAllowlist = !opts.dryRun && !hold && !allowed;
  const dryRun = opts.dryRun === true || (!allowed && !hold);

  const tier = resolveTier(ctx, opts);
  const result = await generateText({
    model: getModel(tier),
    system,
    messages,
    tools: buildTools(ctx, signals, { dryRun, holdCustomerWrites: hold }),
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

  const u = (result.totalUsage ?? result.usage) as
    | { inputTokens?: number; outputTokens?: number; totalTokens?: number }
    | undefined;

  return {
    text: result.text.trim(),
    resolutionSent: signals.resolutionSent,
    toolsUsed: trace.map((t) => t.tool),
    trace,
    dryRun,
    blockedByAllowlist,
    heldCustomerWrites: hold,
    usage: u
      ? { inputTokens: u.inputTokens, outputTokens: u.outputTokens, totalTokens: u.totalTokens }
      : undefined,
    model: modelLabel(tier),
  };
}
