/**
 * Model bake-off: dry-run the full agent loop on real tickets and score each
 * candidate's tool choreography, tokens, cost, and reply text.
 *
 * The model comes from OPENROUTER_MODEL (read by config at import), so run one
 * process per candidate:
 *
 *   OPENROUTER_MODEL=deepseek/deepseek-v4-pro \
 *     npx tsx --env-file=.env.local scripts/model-bakeoff.ts run 13756 13759
 *
 *   npx tsx --env-file=.env.local scripts/model-bakeoff.ts report
 *
 * Results land in .bakeoff/<model-slug>.json; `report` merges them into
 * .bakeoff/report.md. dryRun means no external writes — reads are live.
 */
import fs from "node:fs";
import path from "node:path";
import { buildContext, buildMessages } from "../lib/context";
import { buildSystemPrompt } from "../lib/system-prompt";
import { runAgentLoop, type AgentResult } from "../lib/agent";
import { modelLabel } from "../lib/llm";

const OUT_DIR = process.env.BAKEOFF_DIR ?? path.join(process.cwd(), ".bakeoff");

/** $/MTok input+output for cost estimates (OpenRouter, checked 2026-07-12). */
const PRICES: Record<string, { in: number; out: number }> = {
  "anthropic/claude-sonnet-5": { in: 2, out: 10 },
  "deepseek/deepseek-v4-pro": { in: 0.435, out: 0.87 },
  "moonshotai/kimi-k2.5": { in: 0.375, out: 2.025 },
  "z-ai/glm-5.2": { in: 0.42, out: 1.32 },
  "minimax/minimax-m2.5": { in: 0.15, out: 0.9 },
};

interface BakeoffRun {
  model: string;
  ticketId: string;
  subject?: string;
  toolsUsed: string[];
  checks: {
    repliedExactlyOnce: boolean;
    searchedKbBeforeReply: boolean;
    loggedPrivateNote: boolean;
  };
  durationMs: number;
  usage?: AgentResult["usage"];
  estCostUsd: number | null;
  reply: string;
  error?: string;
}

function checkChoreography(result: AgentResult): BakeoffRun["checks"] {
  const tools = result.toolsUsed;
  const firstReply = tools.indexOf("reply_to_ticket");
  const firstKb = tools.indexOf("search_knowledge_base");
  return {
    repliedExactlyOnce: tools.filter((t) => t === "reply_to_ticket").length === 1,
    searchedKbBeforeReply: firstKb !== -1 && (firstReply === -1 || firstKb < firstReply),
    loggedPrivateNote: tools.includes("add_private_note"),
  };
}

function extractReply(result: AgentResult): string {
  const last = [...result.trace].reverse().find((t) => t.tool === "reply_to_ticket");
  return (last?.input as { body?: string } | undefined)?.body ?? result.text;
}

async function runMode(ticketIds: string[]) {
  const label = modelLabel(); // e.g. openrouter/deepseek/deepseek-v4-pro
  const bareModel = label.replace(/^openrouter\//, "");
  const price = PRICES[bareModel];
  const runs: BakeoffRun[] = [];

  for (const ticketId of ticketIds) {
    process.stderr.write(`[${bareModel}] ticket ${ticketId}… `);
    const started = Date.now();
    try {
      const ctx = await buildContext(ticketId, "freshdesk");
      if (!ctx.ticket) throw new Error("ticket not found");
      const result = await runAgentLoop(
        await buildSystemPrompt(ctx),
        buildMessages(ctx.ticket, "freshdesk"),
        ctx,
        { dryRun: true },
      );
      const u = result.usage;
      const cost =
        price && u
          ? ((u.inputTokens ?? 0) * price.in + (u.outputTokens ?? 0) * price.out) / 1e6
          : null;
      runs.push({
        model: bareModel,
        ticketId,
        subject: ctx.ticket.subject,
        toolsUsed: result.toolsUsed,
        checks: checkChoreography(result),
        durationMs: Date.now() - started,
        usage: u,
        estCostUsd: cost != null ? Number(cost.toFixed(4)) : null,
        reply: extractReply(result),
      });
      process.stderr.write(`ok (${((Date.now() - started) / 1000).toFixed(0)}s)\n`);
    } catch (e) {
      runs.push({
        model: bareModel,
        ticketId,
        toolsUsed: [],
        checks: { repliedExactlyOnce: false, searchedKbBeforeReply: false, loggedPrivateNote: false },
        durationMs: Date.now() - started,
        estCostUsd: null,
        reply: "",
        error: e instanceof Error ? e.message : String(e),
      });
      process.stderr.write(`FAILED: ${e instanceof Error ? e.message : e}\n`);
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const slug = bareModel.replace(/[^a-z0-9.-]+/gi, "_");
  fs.writeFileSync(path.join(OUT_DIR, `${slug}.json`), JSON.stringify(runs, null, 2));
  console.log(`wrote ${OUT_DIR}/${slug}.json`);
}

function reportMode() {
  const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith(".json"));
  const all: BakeoffRun[] = files.flatMap((f) =>
    JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), "utf8")),
  );
  const models = [...new Set(all.map((r) => r.model))];
  const tickets = [...new Set(all.map((r) => r.ticketId))];

  const lines: string[] = ["# Model bake-off report", ""];

  lines.push("## Scorecard", "");
  lines.push("| model | choreography | avg cost/run | avg duration | avg tokens |");
  lines.push("|---|---|---|---|---|");
  for (const m of models) {
    const runs = all.filter((r) => r.model === m);
    const ok = runs.filter(
      (r) => !r.error && r.checks.repliedExactlyOnce && r.checks.searchedKbBeforeReply && r.checks.loggedPrivateNote,
    ).length;
    const costs = runs.map((r) => r.estCostUsd).filter((c): c is number => c != null);
    const avgCost = costs.length ? (costs.reduce((a, b) => a + b, 0) / costs.length).toFixed(4) : "?";
    const avgDur = (runs.reduce((a, r) => a + r.durationMs, 0) / runs.length / 1000).toFixed(0);
    const avgTok = Math.round(
      runs.reduce((a, r) => a + ((r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0)), 0) / runs.length,
    );
    lines.push(`| ${m} | ${ok}/${runs.length} | $${avgCost} | ${avgDur}s | ${avgTok} |`);
  }

  for (const t of tickets) {
    const first = all.find((r) => r.ticketId === t && r.subject);
    lines.push("", `## Ticket ${t} — ${first?.subject ?? ""}`, "");
    for (const m of models) {
      const r = all.find((x) => x.ticketId === t && x.model === m);
      if (!r) continue;
      const c = r.checks;
      const flags = [
        c.repliedExactlyOnce ? "reply✓" : "reply✗",
        c.searchedKbBeforeReply ? "kb✓" : "kb✗",
        c.loggedPrivateNote ? "note✓" : "note✗",
      ].join(" ");
      lines.push(`### ${m}  (${flags}${r.error ? ` — ERROR: ${r.error}` : ""})`);
      lines.push(`tools: ${r.toolsUsed.join(" → ") || "(none)"}`);
      lines.push("", r.reply ? r.reply.split("\n").map((l) => `> ${l}`).join("\n") : "> (no reply produced)", "");
    }
  }

  const out = path.join(OUT_DIR, "report.md");
  fs.writeFileSync(out, lines.join("\n"));
  console.log(`wrote ${out}`);
}

const [mode, ...args] = process.argv.slice(2);
if (mode === "run" && args.length) {
  runMode(args).catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else if (mode === "report") {
  reportMode();
} else {
  console.error("usage: model-bakeoff.ts run <ticketId...> | report");
  process.exit(1);
}
