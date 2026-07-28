/**
 * Jetta-vs-human comparison core — shared by the retrospective benchmark
 * (scripts/human-benchmark.ts) and the "learn from human replies" mining job
 * (app/api/admin/evals/mine-human-replies).
 *
 * For a past ticket, it replays what Jetta WOULD have drafted (dry-run — reads
 * live, writes nothing) and pairs it with the human agent's actual first reply,
 * so the two can be diffed/judged. All read-only.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { fd, stripHtml } from "./tools/freshdesk";
import { buildContext, buildMessages } from "./context";
import { buildSystemPrompt } from "./system-prompt";
import { runAgentLoop } from "./agent";
import { getModel } from "./llm";
import { config } from "./config";
import type { EvalTag } from "./evals";
import { JUNK } from "./intake";

export interface JettaComparison {
  ticketId: string;
  subject: string;
  /** Attributed product (ctx.product) — drives which learnings this maps to. */
  product: string;
  customerMessage: string;
  /** The human agent's first public reply (HTML-stripped). */
  humanReply: string;
  /** Freshdesk user id of that reply's author — compare to config.freshdesk.agentId to spot Jetta's own. */
  humanReplyUserId: number | null;
  humanReplyAt: string;
  /** What Jetta would have replied, from a dry-run replay of the pre-reply state. */
  jettaReply: string;
  jettaToolsUsed: string[];
}

type Convo = { body?: string; body_text?: string; incoming: boolean; private: boolean; user_id?: number; created_at: string };

/**
 * Replay Jetta on a past ticket and pair her draft with the human's first
 * reply. Returns null if the ticket has no usable public agent reply.
 */
export async function jettaDraftForTicket(ticketId: string): Promise<JettaComparison | null> {
  // Raw conversations give us the first agent reply's author (user_id) — which
  // getTicketDetails strips — so callers can tell a human reply from Jetta's own.
  const raw = await fd<{ conversations?: Convo[] }>(`/tickets/${ticketId}?include=conversations`).catch(() => null);
  const firstAgent = (raw?.conversations ?? [])
    .filter((c) => !c.incoming && !c.private)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
  if (!firstAgent) return null;

  const ctx = await buildContext(ticketId, "freshdesk");
  if (!ctx.ticket) return null;

  // Fairness: Jetta sees only the customer messages that existed BEFORE the
  // human replied — never the human's answer.
  const cutoff = Date.parse(firstAgent.created_at);
  ctx.ticket.replies = ctx.ticket.replies.filter(
    (r) => r.author === "customer" && !r.isPrivate && Date.parse(r.createdAt) < cutoff,
  );

  const result = await runAgentLoop(
    await buildSystemPrompt(ctx),
    buildMessages(ctx.ticket, "freshdesk"),
    ctx,
    { dryRun: true },
  );
  const lastReply = [...result.trace].reverse().find((x) => x.tool === "reply_to_ticket");
  const jettaReply = ((lastReply?.input as { body?: string })?.body ?? result.text).trim();

  return {
    ticketId,
    subject: ctx.ticket.subject,
    product: ctx.product,
    customerMessage: `${ctx.ticket.subject}\n\n${ctx.ticket.description}`.slice(0, 4000),
    humanReply: stripHtml(firstAgent.body_text ?? firstAgent.body ?? "").slice(0, 4000),
    humanReplyUserId: firstAgent.user_id ?? null,
    humanReplyAt: firstAgent.created_at,
    jettaReply: jettaReply.slice(0, 4000),
    jettaToolsUsed: result.toolsUsed,
  };
}

/** Jetta test tickets — their "agent" replies are Jetta's approved drafts, not human. */
const JETTA_TEST_TICKETS = new Set(["13662", "13756", "13759", "13762", "13763", "13859"]);

/**
 * Recently resolved/closed tickets a human touched, newest first. Unlike the
 * benchmark's era-cutoff, this allows recent tickets — the mining job filters
 * out Jetta's own replies per-ticket by author user_id instead.
 */
export async function recentResolvedTicketIds(limit: number): Promise<string[]> {
  type T = { id: number; subject?: string; created_at: string; responder_id?: number | null };
  const found: T[] = [];
  for (let page = 1; page <= 10; page++) {
    const d = await fd<{ results: T[]; total: number }>(
      `/search/tickets?query=${encodeURIComponent('"status:4 OR status:5"')}&page=${page}`,
    ).catch(() => null);
    if (!d) break;
    found.push(...d.results);
    if (page * 30 >= Math.min(d.total, 300)) break;
  }
  return found
    .filter((t) => t.subject && !JUNK.test(t.subject) && t.responder_id && !JETTA_TEST_TICKETS.has(String(t.id)))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit)
    .map((t) => String(t.id));
}

const WHY_TAGS = [
  "product-knowledge-gap",
  "account-context",
  "authority",
  "judgment-call",
  "tone",
  "conciseness",
  "wrong-action",
  "policy",
  "other",
] as const;

/**
 * Classify the PRIMARY way the human's reply differed from Jetta's, into the
 * shared EvalTag taxonomy — cheap single call on the light tier.
 */
export async function classifyDivergence(
  customer: string,
  humanReply: string,
  jettaReply: string,
): Promise<EvalTag> {
  const { object } = await generateObject({
    model: getModel("light"),
    schema: z.object({ tag: z.enum(WHY_TAGS) }),
    system:
      "A human support agent replied differently from an AI agent's draft, for a monday.com app portfolio. " +
      "Classify the PRIMARY way the human's reply was better or different. " +
      "product-knowledge-gap: human knew product facts/steps the AI lacked. account-context: human used account/billing/history the AI didn't have. " +
      "authority: human granted something an AI cannot (refund, exception, manual fix). judgment-call: ambiguity needing discretion. " +
      "wrong-action: the AI did the wrong thing. policy: a policy/rule the AI missed. tone / conciseness: style. other: none of these.",
    prompt: `Customer:\n${customer}\n\nHuman reply:\n${humanReply}\n\nAI draft:\n${jettaReply}`,
  });
  return object.tag;
}
