/**
 * A/B eval for the conversation-window fix.
 *
 * Neither existing harness covers this: kb-eval scores retrieval, and
 * human-benchmark judges only FIRST responses — while this change only affects
 * threads longer than 10 conversations. So: run the same long tickets through the
 * agent loop twice, once with the OLD context window (the first 10 conversations,
 * as `?include=conversations` returned) and once with the NEW one (last 20 of the
 * full thread), then blind-judge which reply actually answers what the customer
 * most recently said.
 *
 * Dry-run throughout — reads live, writes nothing.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { buildContext, buildMessages } from "../lib/context";
import { buildSystemPrompt } from "../lib/system-prompt";
import { runAgentLoop, type AgentResult } from "../lib/agent";
import { fd, stripHtml } from "../lib/tools/freshdesk";
import { config } from "../lib/config";
import type { TicketReply } from "../lib/types";

const TICKETS = ["13818", "13659", "13894", "13895", "13901", "13924"];
const REPLY_CHARS = 2000;

type Convo = {
  body_text?: string;
  body?: string;
  private: boolean;
  incoming: boolean;
  from_email?: string;
  created_at: string;
};

/** Exactly what the old code produced: slice(-20) over the embedded first 10. */
async function oldWindowReplies(ticketId: string): Promise<TicketReply[]> {
  const t = await fd<{ conversations?: Convo[] }>(`/tickets/${ticketId}?include=conversations`);
  return (t.conversations ?? []).slice(-20).map((c) => {
    const body = c.body_text ?? stripHtml(c.body ?? "");
    return {
      author: (c.incoming ? "customer" : "agent") as "customer" | "agent",
      authorEmail: c.from_email ?? null,
      body: body.length > REPLY_CHARS ? `${body.slice(0, REPLY_CHARS)}\n[…truncated]` : body,
      createdAt: c.created_at,
      isPrivate: c.private,
    };
  });
}

function replyText(r: AgentResult): string {
  const last = [...r.trace].reverse().find((t) => t.tool === "reply_to_ticket");
  return ((last?.input as { body?: string } | undefined)?.body ?? r.text ?? "").trim();
}

async function draft(ticketId: string, window: "old" | "new"): Promise<string> {
  const ctx = await buildContext(ticketId, "freshdesk");
  if (!ctx.ticket) throw new Error(`ticket ${ticketId} not found`);
  if (window === "old") ctx.ticket.replies = await oldWindowReplies(ticketId);
  const result = await runAgentLoop(
    await buildSystemPrompt(ctx),
    buildMessages(ctx.ticket, "freshdesk"),
    ctx,
    { dryRun: true },
  );
  return replyText(result) || "(no reply produced)";
}

const judgeModel = createOpenRouter({ apiKey: config.openrouter.apiKey! }).chat(
  "anthropic/claude-sonnet-5",
);

async function judge(latest: string, a: string, b: string) {
  const { object } = await generateObject({
    model: judgeModel,
    // Scores as enums, not numbers: Anthropic's structured-output schema rejects
    // minimum/maximum on number types.
    schema: z.object({
      a_addresses_latest: z.enum(["1", "2", "3", "4", "5"]),
      b_addresses_latest: z.enum(["1", "2", "3", "4", "5"]),
      winner: z.enum(["A", "B", "tie"]),
      reason: z.string(),
    }),
    system:
      "You judge customer-support replies. The ONLY question that matters: does the reply respond to what the customer said MOST RECENTLY? " +
      "A reply that answers an earlier, already-handled part of the thread while ignoring the latest message is bad, however polite or well-written it is. " +
      "Score 1 (ignores the latest message entirely) to 5 (directly addresses it). Judge only from the text given.",
    prompt: `The customer's most recent message:\n"""\n${latest.slice(0, 3000)}\n"""\n\nREPLY A:\n"""\n${a.slice(0, 3000)}\n"""\n\nREPLY B:\n"""\n${b.slice(0, 3000)}\n"""`,
  });
  return {
    ...object,
    a_addresses_latest: Number(object.a_addresses_latest),
    b_addresses_latest: Number(object.b_addresses_latest),
  };
}

interface Row {
  ticketId: string;
  convos: number;
  newScore: number;
  oldScore: number;
  winner: "new" | "old" | "tie";
  reason: string;
  oldReply: string;
  newReply: string;
  latest: string;
}

async function main() {
  const rows: Row[] = [];
  for (const [i, ticketId] of TICKETS.entries()) {
    process.stderr.write(`\n[${ticketId}] `);
    const all = await fd<Convo[]>(`/tickets/${ticketId}/conversations?per_page=100`);
    const latestCustomer = all
      .filter((c) => c.incoming)
      .sort((x, y) => x.created_at.localeCompare(y.created_at))
      .pop();
    if (!latestCustomer) {
      process.stderr.write("no customer reply, skipping");
      continue;
    }
    const latest = latestCustomer.body_text ?? stripHtml(latestCustomer.body ?? "");

    process.stderr.write("old… ");
    const oldReply = await draft(ticketId, "old");
    process.stderr.write("new… ");
    const newReply = await draft(ticketId, "new");

    // Alternate which variant is shown first, deterministically, to cancel position bias.
    const newIsA = i % 2 === 0;
    process.stderr.write("judge… ");
    const v = await judge(latest, newIsA ? newReply : oldReply, newIsA ? oldReply : newReply);
    const newScore = newIsA ? v.a_addresses_latest : v.b_addresses_latest;
    const oldScore = newIsA ? v.b_addresses_latest : v.a_addresses_latest;
    const winner =
      v.winner === "tie" ? "tie" : (v.winner === "A") === newIsA ? "new" : "old";

    rows.push({ ticketId, convos: all.length, newScore, oldScore, winner, reason: v.reason, oldReply, newReply, latest });
    process.stderr.write(`new=${newScore} old=${oldScore} winner=${winner}`);
  }

  console.log("\n\n=== conversation-window A/B ===");
  console.log("ticket\tconvos\tnew\told\twinner");
  for (const r of rows) console.log(`${r.ticketId}\t${r.convos}\t${r.newScore}\t${r.oldScore}\t${r.winner}`);
  const avg = (pick: (r: Row) => number) =>
    (rows.reduce((s, r) => s + pick(r), 0) / rows.length).toFixed(2);
  console.log(`\navg addresses-latest — NEW ${avg((r) => r.newScore)}  vs  OLD ${avg((r) => r.oldScore)}`);
  console.log(`wins: new ${rows.filter((r) => r.winner === "new").length}  old ${rows.filter((r) => r.winner === "old").length}  tie ${rows.filter((r) => r.winner === "tie").length}`);
  for (const r of rows) {
    console.log(`\n--- ${r.ticketId} (${r.convos} convos) — ${r.winner}\n  latest customer msg: ${r.latest.replace(/\s+/g, " ").slice(0, 200)}`);
    console.log(`  OLD: ${r.oldReply.replace(/\s+/g, " ").slice(0, 260)}`);
    console.log(`  NEW: ${r.newReply.replace(/\s+/g, " ").slice(0, 260)}`);
    console.log(`  judge: ${r.reason.slice(0, 260)}`);
  }
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
