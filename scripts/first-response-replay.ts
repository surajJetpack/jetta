/**
 * Replay real tickets as if they had just arrived, and show what Jetta's first
 * response would have been, whether the gate would send it, and what the team
 * actually sent. Nothing is written anywhere: the run is a dry run.
 *
 *   npx tsx --env-file=.env.local scripts/first-response-replay.ts 14530 14529 …
 *
 * Each ticket is cut back to the moment before the first public agent reply.
 * Reads Freshdesk (shared 40/min quota with production), so tickets are paced.
 * Locally the KB and learnings come from the DEV store — grounding can be
 * thinner than production's.
 */
import { buildContext, buildMessages } from "../lib/context";
import { buildSystemPrompt } from "../lib/system-prompt";
import { runAgentLoop } from "../lib/agent";
import { hardBlock, judgeFirstResponse, proposedReply, signingBrand, withSignOff } from "../lib/first-response";

const PACE_MS = 20_000;

async function main() {
  const ids = process.argv.slice(2);
  let sent = 0;
  for (const [i, id] of ids.entries()) {
    if (i) await new Promise((r) => setTimeout(r, PACE_MS));
    const ctx = await buildContext(id, "freshdesk");
    if (!ctx.ticket) {
      console.log(`#${id}: not found`);
      continue;
    }
    // Back to the moment it arrived: everything from the first public agent
    // reply on is the future.
    const firstAgent = ctx.ticket.replies.findIndex((r) => r.author === "agent" && !r.isPrivate);
    const human = firstAgent >= 0 ? ctx.ticket.replies[firstAgent].body : "(no human reply)";
    ctx.ticket = {
      ...ctx.ticket,
      replies: (firstAgent >= 0 ? ctx.ticket.replies.slice(0, firstAgent) : ctx.ticket.replies).filter((r) => !r.isPrivate),
      hasPublicAgentReply: false,
      status: "Open",
    };
    ctx.firstResponse = true;

    const result = await runAgentLoop(await buildSystemPrompt(ctx), buildMessages(ctx.ticket, "freshdesk"), ctx, {
      dryRun: true,
    });
    const reply = proposedReply(result);
    const brand = signingBrand(ctx.product);
    const blocked = reply ? hardBlock(reply) : "no_reply";
    const verdict = blocked
      ? { send: false, risk: "hard_check", reason: blocked }
      : await judgeFirstResponse(ctx.ticket, reply!, result, brand);
    if (verdict.send) sent++;

    console.log(`\n══════ #${id} [source ${ctx.ticket.source}] ${ctx.ticket.subject}`);
    console.log(`CUSTOMER: ${ctx.ticket.description.slice(0, 400).replace(/\s+/g, " ")}`);
    console.log(`TOOLS: ${result.toolsUsed.join(", ")}`);
    console.log(`GATE: ${verdict.send ? "SEND" : "HOLD"} (${verdict.risk}) ${verdict.reason}`);
    console.log(`── JETTA (${reply ? reply.split(/\s+/).length : 0} words) ──\n${reply ? withSignOff(reply, brand) : "(none)"}`);
    console.log(`── HUMAN ──\n${human.slice(0, 600)}`);
  }
  console.log(`\n${sent}/${ids.length} would have been sent.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
