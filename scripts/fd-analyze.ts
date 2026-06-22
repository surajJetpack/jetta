/**
 * Analyze the mined (redacted) tickets: cluster into recurring issue categories,
 * distil the canonical agent resolution per category, flag which aren't covered
 * by Jetta's current KB, and draft KB articles for the gaps. Pushes gap drafts
 * into the /kb approval queue (human-gated) and writes a report.
 *
 *   GOOGLE_GENERATIVE_AI_API_KEY=... LLM_PROVIDER=google \
 *   KV_REST_API_URL=... KV_REST_API_TOKEN=... [PUSH=1] npx tsx scripts/fd-analyze.ts
 */
import fs from "node:fs";
import { generateObject } from "ai";
import { z } from "zod";
import { getModel } from "../lib/llm";
import { GETSIGN_KB } from "../lib/knowledge/getsign-kb";
import { addDraft } from "../lib/kv";

const Schema = z.object({
  summary: z.string().describe("2-3 sentence overview of what customers contact support about."),
  agentBestPractices: z.array(z.string()).describe("How human agents handle things well that Jetta should emulate."),
  jettaOpportunities: z.array(z.string()).describe("Where an AI agent could do better/faster than the humans."),
  categories: z
    .array(
      z.object({
        name: z.string(),
        frequency: z.number().int().describe("How many of the tickets fall in this category."),
        exampleTicketIds: z.array(z.number().int()),
        commonProblem: z.string(),
        canonicalResolution: z.string().describe("The reusable, generic fix agents apply — no customer specifics."),
        coveredByKb: z.boolean().describe("Is this already covered by the current KB titles provided?"),
        draft: z.object({
          title: z.string(),
          body: z.string().describe("Clear, reusable support answer/steps. No customer PII."),
          keywords: z.array(z.string()),
        }),
      }),
    )
    .describe("Recurring issue categories, most frequent first."),
});

const SYSTEM = `You analyze REDACTED, resolved support tickets for GetSign / Jetpack Apps to (1) learn how human agents resolve recurring issues and (2) improve an AI support agent's knowledge base.

- Group tickets into recurring ISSUE CATEGORIES (merge near-duplicates). Most frequent first.
- For each category: the common problem, and the CANONICAL resolution agents apply — synthesised, generic, reusable, with NO customer-specific details and NO PII.
- Mark coveredByKb=true only if an existing KB title clearly already covers it.
- Draft a KB article for each category (title, body as clear steps/answer, keywords) that the AI agent could use directly.
- Also surface: what agents do well (to emulate) and where an AI could be faster/better.
- Use ONLY information present in the tickets. If anything that looks like PII remains, omit it.`;

async function main() {
  const tickets = JSON.parse(fs.readFileSync("/tmp/fd-mined.json", "utf8")) as {
    id: number; subject: string; problem: string; resolution: string; tags: string[];
  }[];
  console.error(`analyzing ${tickets.length} tickets…`);

  const corpus = tickets
    .map((t) => `#${t.id} [${(t.tags || []).join(",")}] ${t.subject}\nPROBLEM: ${t.problem}\nRESOLUTION: ${t.resolution}`)
    .join("\n\n----\n\n");
  const kbTitles = GETSIGN_KB.map((a) => a.title).join("; ");

  const { object } = await generateObject({
    model: getModel(),
    schema: Schema,
    system: SYSTEM,
    prompt: `CURRENT KB TITLES:\n${kbTitles}\n\nRESOLVED TICKETS (${tickets.length}):\n\n${corpus}`,
  });

  fs.writeFileSync("/tmp/fd-analysis.json", JSON.stringify(object, null, 2));

  console.log("\n=== SUMMARY ===\n" + object.summary);
  console.log("\n=== AGENT BEST PRACTICES (emulate) ===");
  object.agentBestPractices.forEach((s) => console.log("  • " + s));
  console.log("\n=== WHERE JETTA CAN BE BETTER ===");
  object.jettaOpportunities.forEach((s) => console.log("  • " + s));
  console.log("\n=== RECURRING ISSUE CATEGORIES ===");
  const sorted = [...object.categories].sort((a, b) => b.frequency - a.frequency);
  for (const c of sorted) {
    console.log(`\n[${c.frequency}x] ${c.name}  ${c.coveredByKb ? "✓ in KB" : "✗ GAP"}`);
    console.log(`   problem: ${c.commonProblem.slice(0, 140)}`);
    console.log(`   resolution: ${c.canonicalResolution.slice(0, 200)}`);
  }

  const gaps = sorted.filter((c) => !c.coveredByKb).slice(0, 12);
  console.log(`\n=== ${gaps.length} GAP drafts ${process.env.PUSH ? "→ pushing to approval queue" : "(set PUSH=1 to queue)"} ===`);
  for (const [i, c] of gaps.entries()) {
    console.log(`  • ${c.draft.title}`);
    if (process.env.PUSH) {
      await addDraft({
        id: `mined-${Date.now()}-${i}`,
        channel: "freshdesk-analysis",
        threadTs: `analysis-${i}`,
        title: c.draft.title,
        body: c.draft.body,
        keywords: c.draft.keywords,
        createdBy: "freshdesk-analysis",
        at: Math.floor(Date.now() / 1000),
      });
    }
  }
  console.log("\nFull analysis written to /tmp/fd-analysis.json");
}

main().catch((e) => { console.error("ERROR:", e instanceof Error ? e.message : e); process.exit(1); });
