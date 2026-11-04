/**
 * Self-review, part 2: were Jetta's replies any good?
 *
 * Reconciliation (lib/reconcile.ts) only grades drafts a person used, and most
 * of what Jetta writes now never passes a person first: chat answers go
 * straight to the visitor, first responses send themselves. So a few of her
 * recent replies are read each hour by an independent model, against what the
 * customer actually asked and the evidence her run actually gathered.
 *
 * The judge is never the writer's model. LLM judges prefer their own output
 * (lib/judge.ts measured it: glm grading glm said "human better: 0%"), so the
 * default is Kimi K3.1 Pro (JETTA_SELF_REVIEW_MODEL), a different family from
 * the glm-5.2 that writes tickets and chat. Latency does not matter here.
 *
 * Rule checks run first and need no model: internal links, ticket numbers,
 * placeholders (the first-response hard block), dead links, links that appear
 * nowhere in the evidence, and length. A reply that fails one is "bad" whatever
 * the judge thinks of it.
 *
 * Read-only: nothing here writes to a ticket, a chat or the KB. Findings go to
 * the /self-review page and, for a bad chat answer, to the ops channel.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { config } from "../config";
import { evidenceFromTrace, hardBlock } from "../first-response";
import type { RunLog } from "../kv";
import { ISSUE_CATEGORIES, FIX_TYPES, type JudgedReply, type ReplyKind } from "./types";

// ── what gets judged ────────────────────────────────────────────────

/** The customer-facing text of a run, or null when it wrote none. */
export function replyOf(l: Pick<RunLog, "channel" | "trace" | "reply">): string | null {
  if (l.channel === "jettachat") return l.reply?.trim() || null;
  // Email and dev-bridge runs reach the customer only through reply_to_ticket;
  // their final text is the model's own commentary ("No action needed…").
  const last = [...(l.trace ?? [])].reverse().find((t) => t.tool === "reply_to_ticket");
  const body = (last?.input as { body?: string } | undefined)?.body?.trim();
  return body || null;
}

export function kindOf(l: Pick<RunLog, "source" | "channel">): ReplyKind {
  if (l.channel === "jettachat") return "chat";
  if (l.source === "devboard") return "dev_bridge";
  return "email";
}

/** Runs worth judging: finished, wrote something for a customer, not a console test. */
export function judgeable(l: RunLog): boolean {
  if (l.error || l.dryRun || l.source === "console") return false;
  return replyOf(l) !== null;
}

// ── rule checks ─────────────────────────────────────────────────────

const URL_RE = /https?:\/\/[^\s)<>\]"']+/g;

export function urlsIn(text: string): string[] {
  return [...new Set((text.match(URL_RE) ?? []).map((u) => u.replace(/[.,;:!?]+$/, "")))];
}

/** A link the customer can't open. 401/403 count as fine: it exists, behind a login. */
async function linkIsDead(url: string): Promise<boolean> {
  const attempt = async (method: "HEAD" | "GET") => {
    const res = await fetch(url, { method, redirect: "follow", signal: AbortSignal.timeout(8000), headers: { "user-agent": "Jetta-self-review/1.0" } });
    return res.status;
  };
  try {
    let status = await attempt("HEAD");
    if (status === 405 || status === 400 || status === 403) status = await attempt("GET");
    return status === 404 || status === 410 || status >= 500;
  } catch {
    // A timeout or DNS failure on one check is not proof; only a definite answer counts.
    return false;
  }
}

export async function ruleChecks(
  kind: ReplyKind,
  reply: string,
  evidence: string,
  customerAsk: string,
  opts: { checkLinks?: boolean } = {},
): Promise<string[]> {
  const out: string[] = [];
  const hard = hardBlock(reply.padEnd(40, " "));
  if (hard && hard !== "too_short") out.push(hard);
  if (kind === "chat" && reply.length > 1400) out.push("long_for_chat");
  if (kind !== "chat" && reply.length > 3000) out.push("long");
  const urls = urlsIn(reply);
  const known = `${evidence}\n${customerAsk}`;
  for (const u of urls) {
    // A link that is nowhere in what the run read was made up or remembered.
    // Bare domains ("https://getsign.app") are fine to know by heart.
    const path = u.replace(/^https?:\/\/[^/]+/, "");
    if (path.length > 1 && !known.includes(u) && !known.includes(path)) out.push(`link_not_in_evidence:${u}`);
  }
  if (opts.checkLinks !== false) {
    const dead = await Promise.all(urls.slice(0, 6).map(async (u) => ((await linkIsDead(u)) ? u : null)));
    for (const u of dead) if (u) out.push(`dead_link:${u}`);
  }
  return out;
}

/** Rule checks that make a reply bad on their own. Length and unsourced links are only warnings. */
export function blockingCheck(checks: string[]): boolean {
  return checks.some((c) => !c.startsWith("long") && !c.startsWith("link_not_in_evidence"));
}

// ── the judge ───────────────────────────────────────────────────────

export function judgeModelId(): string {
  return config.selfReview.model;
}

function model(id = judgeModelId()) {
  if (!config.openrouter.apiKey) throw new Error("OPENROUTER_API_KEY is not set (needed for the self-review judge).");
  return createOpenRouter({ apiKey: config.openrouter.apiKey }).chat(id);
}

const Judgement = z.object({
  answered: z.enum(["yes", "partly", "no"]).describe("Did the reply address what the customer actually asked in their latest message?"),
  grounded: z
    .enum(["yes", "partly", "no"])
    .describe("Is every product fact, step, limit, price or promise in the reply supported by the EVIDENCE or the conversation?"),
  issues: z
    .array(
      z.object({
        category: z.enum(ISSUE_CATEGORIES),
        detail: z.string().describe("One sentence, quoting the reply where it helps."),
      }),
    )
    .max(4)
    .describe("Real problems only. Empty for a good reply."),
  score: z.number().int().min(1).max(5).describe("5 = as good as our best human agent; 3 = acceptable but could be clearly better; 1 = harmful or wrong."),
  verdict: z.enum(["good", "weak", "bad"]).describe("good = score 4-5; weak = 3; bad = 1-2 or any wrong/unsupported fact a customer would act on."),
  summary: z.string().describe("One plain sentence for the support lead: what the reply did well or badly."),
  fixType: z.enum(FIX_TYPES).describe(
    "What would most improve this: kb_gap = the knowledge base lacks the fact; prompt = Jetta's instructions/behaviour; tool_or_bug = a tool returned nothing or failed; policy = a rule was broken; none = nothing to fix.",
  ),
  fix: z.string().describe("One concrete sentence: the fact to add to the KB, or the behaviour to change. Empty when fixType is none."),
});

const SYSTEM = `You review replies written by Jetta, the AI support agent for Jetpack Apps (GetSign and other monday.com apps). You are an independent reviewer: be fair, specific and strict about facts.

You get the customer's conversation up to the reply, the EVIDENCE Jetta's run gathered (knowledge-base articles, ticket details, dev-board items, tool results), what she did (replied, escalated to a person), and the reply.

Grade it the way a demanding support lead would:
- Did it answer what the customer asked in their latest message, completely?
- Is every product fact, step, button name, limit, price or promise supported by the evidence or the conversation? A plausible-sounding detail that is NOT in the evidence is an unsupported_claim, and a customer acting on it is the worst outcome: verdict bad.
- Was the action right? A real bug, an account or billing change, or a request she can't fulfil should go to a person (missed_escalation if not). A plain how-to that the evidence answers should not be escalated (needless_escalation).
- Length and tone: chat answers should be short and conversational; emails complete but not padded. Robotic, preachy or over-apologetic tone is "tone".
- Policy: never reveal internal systems, logs, tokens, dev boards, ticket numbers or internal notes; never admit fault or blame anyone; never promise refunds, cancellations, fixes or dates without evidence. Breaking any of these is "policy" or "internal_leak".
- Asking the customer for something genuinely needed (an email, a screenshot, which board) is good, not vague.

If the conversation is marked CONTEXT INCOMPLETE, you cannot know what was asked: do not use not_answered or too_vague, grade only facts, policy and tone, and score no lower than 3 unless the reply itself is wrong or breaks a rule.

Do not punish a reply for missing information the evidence doesn't contain when it honestly says so or hands off. Do not reward length. Judge only what is written.`;

export interface JudgeInput {
  kind: ReplyKind;
  app?: string;
  subject?: string;
  customerAsk: string;
  evidence: string;
  reply: string;
  escalated: boolean;
}

export function judgePrompt(i: JudgeInput): string {
  const channel = i.kind === "chat" ? "live chat (sent to the visitor immediately, no human review)" : i.kind === "dev_bridge" ? "email to the customer, written after a developer updated the dev item" : "email reply on a support ticket";
  return [
    `CHANNEL: ${channel}`,
    i.app ? `APP: ${i.app}` : "",
    i.subject ? `SUBJECT: ${i.subject}` : "",
    `\nCONVERSATION SO FAR (oldest first):\n${i.customerAsk || "(not available)"}`,
    `\nEVIDENCE JETTA'S RUN GATHERED:\n${i.evidence}`,
    `\nWHAT SHE DID: ${i.escalated ? "replied AND escalated to a person" : "replied, did not escalate"}`,
    `\nJETTA'S REPLY:\n${i.reply}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function judgeReply(i: JudgeInput, modelId = judgeModelId()) {
  const once = async () =>
    (
      await generateObject({
        model: model(modelId),
        schema: Judgement,
        system: SYSTEM,
        prompt: judgePrompt(i),
        maxOutputTokens: 4000,
        abortSignal: AbortSignal.timeout(120_000),
      })
    ).object;
  // Reasoning models occasionally return an empty completion (1 in 18 on the
  // first preview); one retry clears it.
  try {
    return await once();
  } catch {
    return await once();
  }
}

export type JudgementResult = z.infer<typeof Judgement>;

/** Combine the rule checks and the judge into the stored row. */
export function finalVerdict(j: JudgementResult, checks: string[]): Pick<JudgedReply, "verdict" | "score" | "issues" | "fixType" | "fix"> {
  const issues = [...j.issues];
  for (const c of checks) {
    if (c.startsWith("dead_link")) issues.push({ category: "broken_link", detail: `Link does not open: ${c.slice(10)}` });
    else if (["internal_link", "ticket_number", "internal_detail", "self_reference", "placeholder"].includes(c)) issues.push({ category: "internal_leak", detail: `Rule check: ${c.replace(/_/g, " ")}` });
    else if (c === "admission") issues.push({ category: "policy", detail: "Rule check: admits fault" });
  }
  if (blockingCheck(checks)) {
    return { verdict: "bad", score: Math.min(j.score, 2), issues, fixType: j.fixType === "none" ? "policy" : j.fixType, fix: j.fix || "A rule check failed; see the issues." };
  }
  // The worse of the score and the stated verdict, so a "good" with a 2 can't
  // hide in the averages and a "bad" for a wrong fact isn't softened by a 3.
  const RANK = { good: 0, weak: 1, bad: 2 } as const;
  const byScore = j.score >= 4 ? "good" : j.score === 3 ? "weak" : "bad";
  const verdict = RANK[j.verdict] > RANK[byScore] ? j.verdict : byScore;
  return { verdict, score: j.score, issues, fixType: verdict === "good" ? "none" : j.fixType, fix: verdict === "good" ? "" : j.fix };
}

export { evidenceFromTrace };
