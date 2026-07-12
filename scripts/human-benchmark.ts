/**
 * Jetta-vs-human retrospective benchmark.
 *
 * Replays real, historically human-handled Freshdesk tickets through Jetta
 * (dry-run — reads live, writes NOTHING) and blind-judges Jetta's draft
 * against the human agent's actual first reply, plus objective metrics
 * (first-response latency, doc citations, escalations).
 *
 *   npx tsx --env-file=.env.local scripts/human-benchmark.ts sample [--limit 30]
 *   npx tsx --env-file=.env.local scripts/human-benchmark.ts run
 *   npx tsx --env-file=.env.local scripts/human-benchmark.ts judge
 *   npx tsx --env-file=.env.local scripts/human-benchmark.ts report
 *
 * State lives in .benchmark/ (gitignored): sample.json → runs.json →
 * judged.json → report.md. Each mode is resumable/idempotent.
 */
import fs from "node:fs";
import path from "node:path";
import { generateObject } from "ai";
import { z } from "zod";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { fd } from "../lib/tools/freshdesk";
import { buildContext, buildMessages } from "../lib/context";
import { buildSystemPrompt } from "../lib/system-prompt";
import { runAgentLoop } from "../lib/agent";
import { config } from "../lib/config";

const DIR = path.join(process.cwd(), ".benchmark");
const arg = (name: string, dflt: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : Number(process.argv[i + 1]);
};

// ── Shared shapes ──────────────────────────────────────────────────

interface SampleTicket {
  ticketId: string;
  subject: string;
  product: string | null;
  createdAt: string;
}

interface BenchRun extends SampleTicket {
  customerMessage: string;
  humanReply: string;
  humanLatencyHours: number;
  jettaReply: string;
  jettaEscalated: boolean;
  jettaToolsUsed: string[];
  jettaDurationS: number;
  jettaCitations: number;
  humanCitations: number;
  error?: string;
}

interface Judged extends BenchRun {
  winner: "human" | "jetta" | "tie";
  scores: { dimension: string; human: number; jetta: number; note: string }[];
  whyHumanWon?: string;
}

const load = <T>(f: string): T => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")) as T;
const save = (f: string, data: unknown) => {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, f), JSON.stringify(data, null, 2));
  console.log(`wrote .benchmark/${f}`);
};

// ── sample ─────────────────────────────────────────────────────────

const JUNK = /automatic reply|auto-?reply|out of office|automatisch antwoord|abwesenheit|undeliverable/i;

/**
 * Only tickets created before Jetta went live on Freshdesk qualify — later
 * "agent" replies may be Jetta's own approved drafts (posted via the shared
 * App Support account), which would contaminate the human baseline.
 */
const HUMAN_ERA_CUTOFF = "2026-07-09";

/** Jetta test tickets — their "agent" replies are Jetta's approved drafts. */
const JETTA_TEST_TICKETS = new Set(["13662", "13756", "13759", "13762", "13763"]);

async function sample(limit: number) {
  type SearchTicket = {
    id: number;
    subject?: string;
    created_at: string;
    custom_fields?: Record<string, unknown>;
    responder_id?: number | null;
  };
  const found: SearchTicket[] = [];
  // FD search API caps at 10 pages × 30; resolved(4) OR closed(5), newest pages first.
  for (let page = 1; page <= 10; page++) {
    const d = await fd<{ results: SearchTicket[]; total: number }>(
      `/search/tickets?query=${encodeURIComponent('"status:4 OR status:5"')}&page=${page}`,
    );
    found.push(...d.results);
    if (page * 30 >= Math.min(d.total, 300)) break;
  }
  // Newest first, junk filtered, must have a responder (a human touched it).
  const clean = found
    .filter(
      (t) =>
        t.subject &&
        !JUNK.test(t.subject) &&
        t.responder_id &&
        t.created_at < HUMAN_ERA_CUTOFF &&
        !JETTA_TEST_TICKETS.has(String(t.id)),
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  // Stratify: round-robin across products so no single app dominates.
  const byProduct = new Map<string, SearchTicket[]>();
  for (const t of clean) {
    const p = ((t.custom_fields?.cf_product as string) ?? "unlabeled").trim() || "unlabeled";
    (byProduct.get(p) ?? byProduct.set(p, []).get(p)!).push(t);
  }
  const picked: SearchTicket[] = [];
  const buckets = [...byProduct.values()];
  for (let round = 0; picked.length < limit && buckets.some((b) => b.length > round); round++) {
    for (const b of buckets) {
      if (picked.length >= limit) break;
      if (b[round]) picked.push(b[round]);
    }
  }

  const out: SampleTicket[] = picked.map((t) => ({
    ticketId: String(t.id),
    subject: t.subject ?? "",
    product: ((t.custom_fields?.cf_product as string) ?? null) || null,
    createdAt: t.created_at,
  }));
  save("sample.json", out);
  for (const s of out) console.log(`  ${s.ticketId}  [${s.product ?? "—"}]  ${s.subject.slice(0, 70)}`);
}

// ── run ────────────────────────────────────────────────────────────

const countCitations = (text: string) =>
  (text.match(/https?:\/\/(getsign\.io|jetpackapps\.io)[^\s)>\]]*/g) ?? []).length;

async function run() {
  const tickets = load<SampleTicket[]>("sample.json");
  const runs: BenchRun[] = fs.existsSync(path.join(DIR, "runs.json")) ? load("runs.json") : [];
  const done = new Set(runs.map((r) => r.ticketId));

  for (const t of tickets) {
    if (done.has(t.ticketId)) continue;
    process.stderr.write(`ticket ${t.ticketId}… `);
    try {
      const ctx = await buildContext(t.ticketId, "freshdesk");
      if (!ctx.ticket) throw new Error("not found");

      // Human baseline: first public agent reply.
      const firstHuman = ctx.ticket.replies.find((r) => r.author === "agent" && !r.isPrivate);
      if (!firstHuman) throw new Error("no public agent reply");
      const humanLatencyHours =
        (Date.parse(firstHuman.createdAt) - Date.parse(t.createdAt)) / 3_600_000;

      // Fairness: Jetta sees only what existed BEFORE the human replied.
      const cutoff = Date.parse(firstHuman.createdAt);
      ctx.ticket.replies = ctx.ticket.replies.filter(
        (r) => r.author === "customer" && !r.isPrivate && Date.parse(r.createdAt) < cutoff,
      );

      const started = Date.now();
      const result = await runAgentLoop(
        await buildSystemPrompt(ctx),
        buildMessages(ctx.ticket, "freshdesk"),
        ctx,
        { dryRun: true },
      );
      const lastReply = [...result.trace].reverse().find((x) => x.tool === "reply_to_ticket");
      const jettaReply = ((lastReply?.input as { body?: string })?.body ?? result.text).trim();

      runs.push({
        ...t,
        customerMessage: `${ctx.ticket.subject}\n\n${ctx.ticket.description}`.slice(0, 4000),
        humanReply: firstHuman.body.slice(0, 4000),
        humanLatencyHours: Number(humanLatencyHours.toFixed(1)),
        jettaReply: jettaReply.slice(0, 4000),
        jettaEscalated: result.toolsUsed.includes("send_escalation"),
        jettaToolsUsed: result.toolsUsed,
        jettaDurationS: Number(((Date.now() - started) / 1000).toFixed(1)),
        jettaCitations: countCitations(jettaReply),
        humanCitations: countCitations(firstHuman.body),
      });
      process.stderr.write("ok\n");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      runs.push({
        ...t,
        customerMessage: "",
        humanReply: "",
        humanLatencyHours: 0,
        jettaReply: "",
        jettaEscalated: false,
        jettaToolsUsed: [],
        jettaDurationS: 0,
        jettaCitations: 0,
        humanCitations: 0,
        error: msg,
      });
      process.stderr.write(`SKIP: ${msg}\n`);
    }
    save("runs.json", runs);
  }
}

// ── judge ──────────────────────────────────────────────────────────

const JUDGE_MODEL = "anthropic/claude-sonnet-5"; // independent from GLM (the contestant)

const VerdictSchema = z.object({
  scores: z.array(
    z.object({
      dimension: z.enum(["correctness", "completeness", "actionability", "tone"]),
      a: z.number().describe("1-5 score for Reply A"),
      b: z.number().describe("1-5 score for Reply B"),
      note: z.string().describe("One sentence justifying the scores."),
    }),
  ),
  winner: z.enum(["A", "B", "tie"]),
});

const WhySchema = z.object({
  whyHumanWon: z.enum([
    "product-knowledge-gap",
    "account-context",
    "authority",
    "judgment-call",
    "tone",
    "conciseness",
    "other",
  ]),
});

function judgeModel() {
  if (!config.openrouter.apiKey) throw new Error("OPENROUTER_API_KEY is not set.");
  return createOpenRouter({ apiKey: config.openrouter.apiKey }).chat(JUDGE_MODEL);
}

async function judgePair(customer: string, a: string, b: string) {
  const { object } = await generateObject({
    model: judgeModel(),
    schema: VerdictSchema,
    system:
      "You judge customer-support replies for a monday.com app portfolio (GetSign e-signatures, TrackMy, VLOOKUP and others). " +
      "Score each reply 1-5 on: correctness (factually right, grounded, no invented steps), completeness (fully addresses the request), " +
      "actionability (concrete steps the customer can follow), tone (professional, empathetic, right length). " +
      "You cannot verify product facts — judge grounding by specificity and internal consistency. Pick an overall winner; use 'tie' when genuinely close.",
    prompt: `Customer message:\n${customer}\n\n--- Reply A ---\n${a}\n\n--- Reply B ---\n${b}`,
  });
  return object;
}

async function judge() {
  const runs = load<BenchRun[]>("runs.json").filter((r) => !r.error && r.jettaReply && r.humanReply);
  const judged: Judged[] = fs.existsSync(path.join(DIR, "judged.json")) ? load("judged.json") : [];
  const done = new Set(judged.map((r) => r.ticketId));

  for (const r of runs) {
    if (done.has(r.ticketId)) continue;
    process.stderr.write(`judging ${r.ticketId}… `);
    // Both orderings; disagreement → tie (kills position bias).
    const v1 = await judgePair(r.customerMessage, r.humanReply, r.jettaReply); // A=human
    const v2 = await judgePair(r.customerMessage, r.jettaReply, r.humanReply); // A=jetta
    const w1 = v1.winner === "A" ? "human" : v1.winner === "B" ? "jetta" : "tie";
    const w2 = v2.winner === "A" ? "jetta" : v2.winner === "B" ? "human" : "tie";
    const winner: Judged["winner"] = w1 === w2 ? w1 : "tie";

    const scores = v1.scores.map((s) => {
      const s2 = v2.scores.find((x) => x.dimension === s.dimension);
      return {
        dimension: s.dimension,
        human: (s.a + (s2?.b ?? s.a)) / 2,
        jetta: (s.b + (s2?.a ?? s.b)) / 2,
        note: s.note,
      };
    });

    let whyHumanWon: string | undefined;
    if (winner === "human") {
      const { object } = await generateObject({
        model: judgeModel(),
        schema: WhySchema,
        system:
          "A human support agent's reply beat an AI agent's reply. Classify the PRIMARY reason the human won. " +
          "product-knowledge-gap: the human knew product facts/steps the AI's knowledge base lacks. " +
          "account-context: the human used customer/billing/history context the AI didn't have. " +
          "authority: the human granted something an AI cannot (refund, exception, manual fix). " +
          "judgment-call: ambiguity needing discretion. tone / conciseness: style. other: none of these.",
        prompt: `Customer:\n${r.customerMessage}\n\nHuman reply (winner):\n${r.humanReply}\n\nAI reply:\n${r.jettaReply}`,
      });
      whyHumanWon = object.whyHumanWon;
    }

    judged.push({ ...r, winner, scores, whyHumanWon });
    process.stderr.write(`${winner}\n`);
    save("judged.json", judged);
  }
}

// ── report ─────────────────────────────────────────────────────────

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

function report() {
  const judged = load<Judged[]>("judged.json");
  const runs = load<BenchRun[]>("runs.json");
  const skipped = runs.filter((r) => r.error);
  const L: string[] = ["# Jetta vs human agents — retrospective benchmark", ""];
  L.push(`${judged.length} tickets judged (${skipped.length} skipped: ${skipped.map((s) => s.ticketId).join(", ") || "none"}). Jetta ran in dry-run replay: she saw only the pre-reply ticket state. Judge: ${JUDGE_MODEL}, blind pairwise, both orderings (disagreement = tie).`, "");

  const wins = (w: string) => judged.filter((j) => j.winner === w).length;
  L.push("## Scorecard", "");
  L.push(`| | Jetta wins | ties | human wins |`, `|---|---|---|---|`);
  L.push(`| overall (${judged.length}) | ${wins("jetta")} | ${wins("tie")} | ${wins("human")} |`);
  const products = [...new Set(judged.map((j) => j.product ?? "unlabeled"))];
  for (const p of products) {
    const g = judged.filter((j) => (j.product ?? "unlabeled") === p);
    L.push(
      `| ${p} (${g.length}) | ${g.filter((j) => j.winner === "jetta").length} | ${g.filter((j) => j.winner === "tie").length} | ${g.filter((j) => j.winner === "human").length} |`,
    );
  }

  L.push("", "## Dimension scores (mean, 1-5)", "", `| dimension | human | jetta |`, `|---|---|---|`);
  for (const dim of ["correctness", "completeness", "actionability", "tone"]) {
    const hs = judged.flatMap((j) => j.scores.filter((s) => s.dimension === dim).map((s) => s.human));
    const js = judged.flatMap((j) => j.scores.filter((s) => s.dimension === dim).map((s) => s.jetta));
    const avg = (xs: number[]) => (xs.reduce((a, b) => a + b, 0) / (xs.length || 1)).toFixed(2);
    L.push(`| ${dim} | ${avg(hs)} | ${avg(js)} |`);
  }

  L.push("", "## Objective metrics", "");
  L.push(`- Median first-response time: human **${median(judged.map((j) => j.humanLatencyHours)).toFixed(1)}h** vs Jetta **${median(judged.map((j) => j.jettaDurationS)).toFixed(0)}s**`);
  const withC = (xs: BenchRun[], f: (r: BenchRun) => number) => Math.round((xs.filter((r) => f(r) > 0).length / (xs.length || 1)) * 100);
  L.push(`- Replies citing documentation: human **${withC(judged, (r) => r.humanCitations)}%** vs Jetta **${withC(judged, (r) => r.jettaCitations)}%**`);
  L.push(`- Jetta escalated instead of answering: ${judged.filter((j) => j.jettaEscalated).length}/${judged.length}`);

  const humanWins = judged.filter((j) => j.winner === "human");
  L.push("", "## Where humans win", "");
  const tags = new Map<string, Judged[]>();
  for (const j of humanWins) {
    const t = j.whyHumanWon ?? "other";
    (tags.get(t) ?? tags.set(t, []).get(t)!).push(j);
  }
  for (const [tag, js] of [...tags.entries()].sort((a, b) => b[1].length - a[1].length)) {
    L.push(`- **${tag}** (${js.length}): ${js.map((j) => `#${j.ticketId}`).join(", ")}`);
  }

  L.push("", "## Where Jetta wins", "");
  for (const j of judged.filter((x) => x.winner === "jetta")) {
    L.push(`- #${j.ticketId} [${j.product ?? "—"}] ${j.subject.slice(0, 60)}`);
  }

  L.push("", "## Recommended improvements", "");
  const kbGaps = tags.get("product-knowledge-gap") ?? [];
  if (kbGaps.length)
    L.push(`1. **KB articles to write** (${kbGaps.length} tickets lost to missing product knowledge): ${kbGaps.map((j) => `#${j.ticketId} "${j.subject.slice(0, 50)}"`).join("; ")} — feed these through the knowledge loop.`);
  const acct = tags.get("account-context") ?? [];
  if (acct.length)
    L.push(`2. **Context/tool gaps** (${acct.length} tickets): humans used account/billing/history context Jetta lacks — review what data source would close this: ${acct.map((j) => `#${j.ticketId}`).join(", ")}.`);
  const style = [...(tags.get("tone") ?? []), ...(tags.get("conciseness") ?? [])];
  if (style.length)
    L.push(`3. **System-prompt tuning** (${style.length} tickets on tone/conciseness): ${style.map((j) => `#${j.ticketId}`).join(", ")}.`);
  const auth = tags.get("authority") ?? [];
  if (auth.length)
    L.push(`4. **Working as designed** (${auth.length} authority tickets): humans granted refunds/exceptions — Jetta correctly cannot; escalation is the right behavior.`);

  L.push("", "---", "", "## Appendix — per ticket", "");
  for (const j of judged) {
    L.push(`### #${j.ticketId} [${j.product ?? "—"}] — winner: ${j.winner}${j.whyHumanWon ? ` (${j.whyHumanWon})` : ""}`);
    L.push("", `**Customer:**\n> ${j.customerMessage.split("\n").join("\n> ")}`, "");
    L.push(`**Human** (${j.humanLatencyHours}h):\n> ${j.humanReply.split("\n").join("\n> ")}`, "");
    L.push(`**Jetta** (${j.jettaDurationS}s, tools: ${j.jettaToolsUsed.join("→") || "none"}):\n> ${j.jettaReply.split("\n").join("\n> ")}`, "");
    for (const s of j.scores) L.push(`- ${s.dimension}: human ${s.human} vs jetta ${s.jetta} — ${s.note}`);
    L.push("");
  }

  fs.writeFileSync(path.join(DIR, "report.md"), L.join("\n"));
  console.log(`wrote .benchmark/report.md (${judged.length} tickets)`);
}

// ── main ───────────────────────────────────────────────────────────

const mode = process.argv[2];
const main =
  mode === "sample" ? () => sample(arg("limit", 30))
  : mode === "run" ? run
  : mode === "judge" ? judge
  : mode === "report" ? async () => report()
  : null;
if (!main) {
  console.error("usage: human-benchmark.ts sample [--limit N] | run | judge | report");
  process.exit(1);
}
main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
