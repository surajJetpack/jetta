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
import { logOpsEvent } from "./events";

/** One executed tool call, for display/auditing. */
export interface TraceEntry {
  tool: string;
  input: unknown;
  result: string;
  /** The tool threw. `result` carries the error message. */
  failed?: boolean;
}

export interface AgentResult {
  /** Final natural-language text from Jetta. */
  text: string;
  /** True if a tool logged a resolution, signalling a 24h follow-up. */
  resolutionSent: boolean;
  /** Names of tools executed, in order. */
  /** Tools that ran this turn. A call that threw is in `toolsFailed`, not here. */
  toolsUsed: string[];
  toolsFailed: string[];
  /** Tools that ran without error but declined to act, one name per such call. */
  toolsDeclined: string[];
  /** Full per-call trace (tool, input, result). */
  trace: TraceEntry[];
  /** The dry-run mode actually used. */
  dryRun: boolean;
  /** True if customer-visible writes (reply/close) were held for human approval. */
  heldCustomerWrites: boolean;
  /** Aggregate token usage across the loop. Cache fields only when the provider caches. */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  /** Label of the model that actually ran this loop (provider/model-id). */
  model: string;
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

/**
 * Which tools did their job, which threw, and which ran but declined. Pure,
 * for the test script.
 *
 * `toolsUsed` is what readers act on, so it holds only calls that happened:
 * not ones that threw, and not ones the tool itself declined (`declined`, one
 * name per declined call — see AgentSignals). A tool called twice, declined
 * once and done once, is used once.
 */
export function toolLists(
  trace: Pick<TraceEntry, "tool" | "failed">[],
  declined: string[] = [],
): { toolsUsed: string[]; toolsFailed: string[]; toolsDeclined: string[] } {
  const left = new Map<string, number>();
  for (const name of declined) left.set(name, (left.get(name) ?? 0) + 1);
  const toolsUsed: string[] = [];
  for (const t of trace) {
    if (t.failed) continue;
    const n = left.get(t.tool) ?? 0;
    if (n > 0) left.set(t.tool, n - 1);
    else toolsUsed.push(t.tool);
  }
  return {
    toolsUsed,
    toolsFailed: trace.filter((t) => t.failed).map((t) => t.tool),
    toolsDeclined: [...declined],
  };
}

export async function runAgentLoop(
  system: string,
  messages: ModelMessage[],
  ctx: ConversationContext,
  opts: RunOptions = {},
): Promise<AgentResult> {
  const signals: AgentSignals = { resolutionSent: false };

  const hold = opts.holdCustomerWrites === true;
  const dryRun = opts.dryRun === true;

  const tier = resolveTier(ctx, opts);
  const result = await generateText({
    model: getModel(tier),
    system,
    messages,
    tools: buildTools(ctx, signals, { dryRun, holdCustomerWrites: hold }),
    stopWhen: stepCountIs(config.llm.maxSteps),
    // Anthropic automatic prompt caching via OpenRouter: the tool loop
    // re-sends system+tools+history every step, so steps 2+ read the shared
    // prefix at ~0.1x input price. No-op for non-Anthropic models (DeepSeek/
    // GLM/Kimi cache automatically server-side) and for other providers.
    providerOptions: {
      openrouter: { cache_control: { type: "ephemeral" } },
    },
  });

  const traceTicketId = ctx.ticket?.id;
  const trace: TraceEntry[] = [];
  for (const step of result.steps) {
    // Tool failures live in `content` as tool-error parts, NOT in toolResults.
    // Reading only toolResults recorded a thrown tool as result: "" — which is
    // how a create_support_ticket that had never once succeeded in production
    // stayed invisible for as long as it did. The only evidence anything was
    // wrong was Jetta apologising to the customer.
    const errors = new Map<string, unknown>();
    for (const part of step.content as { type?: string; toolCallId?: string; error?: unknown }[]) {
      if (part?.type === "tool-error" && part.toolCallId) errors.set(part.toolCallId, part.error);
    }

    for (const call of step.toolCalls) {
      const failure = errors.get(call.toolCallId);
      if (failure !== undefined) {
        const message = failure instanceof Error ? failure.message : String(failure);
        trace.push({ tool: call.toolName, input: call.input, result: `ERROR: ${message}`, failed: true });
        // Loud, because a broken tool is an outage of one of Jetta's hands and
        // nothing else in the system will say so.
        console.error(`Tool ${call.toolName} failed:`, message);
        void logOpsEvent({
          level: "error",
          event: "tool.failed",
          source: ctx.channel === "freshdesk" ? "webhook" : ctx.channel,
          ticketId: traceTicketId,
          data: { tool: call.toolName, error: message.slice(0, 600) },
        }).catch(() => {});
        continue;
      }
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
    | {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
      }
    | undefined;

  // A turn that handed the problem to engineering is not a resolution, however
  // the model labelled its note — the customer is now waiting on US, and a
  // resolutionSent here schedules the "I'll assume this is resolved" close.
  const lists = toolLists(trace, signals.declined);
  // "Handed off" means it happened: an escalation that posted, an item that
  // was filed. A create_dev_item that came back "NOT filed" handed nothing to
  // anyone.
  const handedOff = lists.toolsUsed.some((t) => t === "send_escalation" || t === "create_dev_item");
  // Same rule for a handoff that happened on an EARLIER turn: while the dev
  // board still has an item for this ticket in flight, the issue is not
  // resolved, whatever this turn's note says. "Still with the team, I'll keep
  // you posted" tagged resolution_sent is exactly how a follow-up gets
  // scheduled against a customer who is waiting on engineering.
  const withEngineering = (ctx.ticketDevItems ?? []).some((i) => i.state === "open");

  return {
    text: result.text.trim(),
    resolutionSent: signals.resolutionSent && !handedOff && !withEngineering,
    // Only calls that ran. A tool that threw did nothing, and every reader of
    // this list treats a name on it as a thing that happened: a failed
    // send_escalation was recorded as an escalation, and a failed
    // create_support_ticket had the chat tell the visitor a ticket was opened.
    // The trace keeps the failures, marked.
    ...lists,
    trace,
    dryRun,
    heldCustomerWrites: hold,
    usage: u
      ? {
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          totalTokens: u.totalTokens,
          cacheReadTokens: u.inputTokenDetails?.cacheReadTokens,
          cacheWriteTokens: u.inputTokenDetails?.cacheWriteTokens,
        }
      : undefined,
    model: modelLabel(tier),
  };
}
