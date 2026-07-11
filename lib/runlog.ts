/**
 * Assemble a detailed RunLog from an agent run and persist it. Called by the
 * webhook, the console runner, and the cron so every run is recorded with its
 * full trace, KB hits, reply, flags, timing, and token usage.
 */
import crypto from "node:crypto";
import type { ConversationContext } from "./types";
import type { AgentResult } from "./agent";
import { recordRunLog, type RunLog } from "./kv";
import { log } from "./logger";

/** Pull KB hits (title/source/score) out of the search_knowledge_base trace entries. */
function extractKbHits(trace: AgentResult["trace"]): RunLog["kbHits"] {
  const hits: RunLog["kbHits"] = [];
  for (const t of trace) {
    if (t.tool !== "search_knowledge_base" || typeof t.result !== "string") continue;
    try {
      const arr = JSON.parse(t.result) as { title?: string; source?: string; score?: number }[];
      if (Array.isArray(arr)) {
        for (const a of arr) {
          if (a.title) hits.push({ title: a.title, source: a.source ?? "?", score: a.score });
        }
      }
    } catch {
      // result was a plain message (e.g. "No knowledge base articles matched.")
    }
  }
  return hits;
}

function extractReply(result: AgentResult): string {
  const last = [...result.trace].reverse().find((t) => t.tool === "reply_to_ticket");
  const body = (last?.input as { body?: string } | undefined)?.body;
  return body ?? result.text;
}

export async function recordRun(
  source: RunLog["source"],
  ctx: ConversationContext,
  result: AgentResult,
  durationMs: number,
  error?: unknown,
): Promise<void> {
  const entry: RunLog = {
    id: crypto.randomUUID(),
    at: Math.floor(Date.now() / 1000),
    source,
    ticketId: ctx.ticket?.id ?? "unknown",
    subject: ctx.ticket?.subject,
    channel: ctx.channel,
    product: ctx.product,
    model: result.model,
    complexity: ctx.complexity,
    dryRun: result.dryRun,
    blockedByAllowlist: result.blockedByAllowlist,
    heldCustomerWrites: result.heldCustomerWrites || undefined,
    replied: result.toolsUsed.includes("reply_to_ticket"),
    resolutionSent: result.resolutionSent,
    escalated: result.toolsUsed.includes("send_escalation"),
    durationMs,
    usage: result.usage,
    reply: extractReply(result),
    kbHits: extractKbHits(result.trace),
    trace: result.trace,
    error: error instanceof Error ? error.message : error ? String(error) : undefined,
  };
  await recordRunLog(entry).catch((e) => log.error("recordRunLog_failed", e, { ticketId: entry.ticketId }));
  log.info("run", {
    source,
    ticketId: entry.ticketId,
    tools: result.toolsUsed,
    dryRun: entry.dryRun,
    escalated: entry.escalated,
    resolutionSent: entry.resolutionSent,
    durationMs,
  });
}
