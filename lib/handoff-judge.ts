/**
 * Handoff judge — for a ticket Jetta handed to people, decide what it turned
 * out to be: a real bug that needed a developer, or a knowledge gap she could
 * have answered with the right fact.
 *
 * Why it exists: Jetta escalates a lot, and an escalation is only correct when
 * the ticket actually needed engineering. The monday boards can't say which —
 * "Root Cause" is never filled in, and 80 of her first 107 dev items carry no
 * engineering comment at all, just a Dev Status of Done. The truth is spread
 * across the dev thread AND the Freshdesk replies that came after the handoff
 * ("our developers fixed it" vs "here's how to set it up"), so the judge reads
 * both. Methodology and categories match the 2026-09-24 handoff audit.
 *
 * For a knowledge gap it also names the missing fact and checks the closest
 * published KB articles, so the page can say whether the KB lacks it or Jetta
 * failed to use what was there.
 *
 * The model is lib/judge.ts's independent judge, not Jetta's own standard tier:
 * this grades her escalations, and a model grading its own calls is the bias
 * that module was written to avoid. Measured too — on 20 handoffs with known
 * verdicts, the standard tier (glm-5.2) agreed on 11 and returned nothing
 * parseable on 3.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { JUDGE_MODEL, judgeModel } from "./judge";
import { searchPublishedKb } from "./kb-store";
import { getDevItemOutcomes, type DevItemOutcome } from "./tools/monday";
import type { HandoffOutcome, PerfConversation, PerfTicket } from "./performance";

const Verdict = z.object({
  category: z.enum(["real_bug", "knowledge_gap", "feature_request", "account_action", "customer_environment", "unresolved"]),
  confidence: z.enum(["high", "medium", "low"]),
  evidence: z.string().describe("One sentence: the deciding fact from the dev comments or the agents' replies."),
  missingKnowledge: z
    .string()
    .nullable()
    .describe("knowledge_gap only: the generic product fact or steps Jetta needed. No customer names or other personal data."),
  kbArticleTitle: z.string().nullable().describe("knowledge_gap only: a title for the KB article that would have let Jetta answer."),
  kbCoverage: z
    .enum(["covered", "partly_covered", "not_covered"])
    .nullable()
    .describe("knowledge_gap only: does one of the CANDIDATE KB ARTICLES already state that fact clearly enough to answer from?"),
  kbArticle: z.string().nullable().describe("Title of the candidate article that covers it, if any."),
});

export const HANDOFF_SYSTEM = `You audit handoffs by an AI support agent ("Jetta") for monday.com apps (GetSign e-signature, and Jetpack Apps: VLOOKUP Auto-Link, TrackMy, Triggerly, Smart Columns, Extract, Jobflows, etc.). Jetta escalated each ticket to humans or developers instead of answering it herself. Decide what the ticket turned out to be, from what happened AFTER the handoff: developer comments on the monday dev item, its Dev Status, and the human agents' later replies to the customer.

Categories:
- real_bug: a defect in OUR product that needed a code, config or deploy change by our developers (fixed, deployed, or confirmed as a bug still being worked on).
- knowledge_gap: our product worked as designed. Resolved by explaining setup, usage, a limitation, plan limits or a workaround — or the customer's own misconfiguration was fixed by instructions. Jetta could have answered with the right product knowledge.
- feature_request: the customer wants a capability that doesn't exist yet.
- account_action: needed a human with system access — billing, refunds, plan or trial changes, invoices, data repair, backend clean-up, account or permission changes on our side.
- customer_environment: caused by the monday.com platform, a third party (courier API, email provider), or the customer's environment — not our bug and not answerable from our docs.
- unresolved: no outcome visible yet, or the evidence can't distinguish.

Be strict. "Done" on the dev board alone does NOT prove a bug — developers also close items after explaining usage. Look for fixed / deployed / patched / bug versus "working as expected", "configuration", "you need to", "limitation". If the agent later told the customer the developers fixed it, that is real_bug. If the agent explained how to set something up and the customer confirmed it works, that is knowledge_gap.

For knowledge_gap only, also judge the CANDIDATE KB ARTICLES: "covered" only if one states the needed fact clearly enough to answer from. Otherwise leave the KB fields null.`;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)} …` : s);
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The judge's whole view of one handoff, as text. Pure so it can be tested:
 * the thread from the handoff onward (Jetta's own notes are listed separately —
 * her later "still escalated" notes are not evidence of the outcome), then each
 * dev item's status and thread, then the KB candidates.
 */
export function handoffEvidence(input: {
  ticket: Pick<PerfTicket, "id" | "subject" | "status"> & { handoff?: PerfTicket["handoff"] };
  description: string | null;
  thread: PerfConversation[];
  jettaId: number | null;
  agents: Map<number, string>;
  devItems: DevItemOutcome[];
  kbCandidates: { title: string; body: string }[];
}): string {
  const { ticket, thread, jettaId, agents } = input;
  const sorted = [...thread].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const isJetta = (m: PerfConversation) => m.private && jettaId != null && m.user_id === jettaId;
  const jettaNotes = sorted.filter((m) => isJetta(m) && !/^Jetta — suggested reply/.test((m.body_text ?? "").trim()));
  // The outcome starts at the handoff itself — earlier replies are the problem, not its resolution.
  const from = ticket.handoff?.at ?? jettaNotes[0]?.created_at ?? sorted[0]?.created_at ?? "";
  const who = (m: PerfConversation) =>
    m.private
      ? `[private note by ${agents.get(m.user_id ?? -1) ?? "someone"}]`
      : m.incoming
        ? "[customer]"
        : `[agent ${agents.get(m.user_id ?? -1) ?? "?"}]`;
  const after = sorted
    .filter((m) => m.created_at >= from && !isJetta(m))
    .map((m) => `${m.created_at.slice(0, 10)} ${who(m)}: ${clip(flat(m.body_text ?? ""), 900)}`)
    .join("\n");
  const items = input.devItems
    .map((it) => {
      const ups = it.updates
        .map((u) => {
          const replies = u.replies.map((r) => `    ↳ ${r.author}: ${clip(flat(r.text), 500)}`).join("\n");
          return `  ${u.at.slice(0, 10)} ${u.author}: ${clip(flat(u.text), 700)}${replies ? `\n${replies}` : ""}`;
        })
        .join("\n");
      return `DEV ITEM "${it.name}" — board group: ${it.group ?? "?"}; Dev Status: ${it.devStatus ?? "(none)"}\n${ups}`;
    })
    .join("\n\n");
  return `TICKET #${ticket.id}: ${ticket.subject ?? "(no subject)"} — Freshdesk status code ${ticket.status ?? "?"} (2 open, 3 pending, 4 resolved, 5 closed)
CUSTOMER'S OPENING MESSAGE:
${clip(flat(input.description ?? "(not available)"), 1500)}

JETTA'S HANDOFF NOTES:
${jettaNotes.map((m) => clip(flat(m.body_text ?? ""), 700)).join("\n---\n") || "(none)"}

${items || "NO DEV ITEM LINKED."}

EVERYTHING AFTER THE HANDOFF (agents, customer, human private notes):
${clip(after || "(nothing yet)", 7000)}

CANDIDATE KB ARTICLES (only for judging coverage of a knowledge gap):
${input.kbCandidates.map((a, i) => `(${i + 1}) ${a.title}\n${clip(flat(a.body), 1500)}`).join("\n\n") || "(none found)"}`;
}

/**
 * Judge one handoff. Reads the dev items from monday and the closest KB
 * articles; the Freshdesk thread comes from the caller, which already has it.
 */
export async function judgeHandoff(input: {
  ticket: PerfTicket;
  description: string | null;
  thread: PerfConversation[];
  jettaId: number | null;
  agents: Map<number, string>;
  /** Items found on the boards by ticket link, beyond the ones her notes name. */
  extraItemIds?: string[];
}): Promise<HandoffOutcome> {
  const { ticket } = input;
  const devItems = await getDevItemOutcomes([...(ticket.handoff?.itemIds ?? []), ...(input.extraItemIds ?? [])]);
  const kbCandidates = await searchPublishedKb(`${ticket.subject ?? ""} ${clip(input.description ?? "", 400)}`, 3).catch(() => []);
  const { object } = await generateObject({
    model: judgeModel(),
    maxOutputTokens: 1500,
    schema: Verdict,
    system: HANDOFF_SYSTEM,
    prompt: handoffEvidence({ ...input, devItems, kbCandidates }),
  });
  const gap = object.category === "knowledge_gap";
  return {
    ticketId: ticket.id,
    category: object.category,
    confidence: object.confidence,
    evidence: object.evidence,
    missingKnowledge: gap ? object.missingKnowledge : null,
    kbArticleTitle: gap ? object.kbArticleTitle : null,
    kbCoverage: gap ? object.kbCoverage : null,
    kbArticle: gap ? object.kbArticle : null,
    judgedAt: Date.now(),
    basisUpdatedAt: ticket.updatedAt,
    model: `openrouter/${JUDGE_MODEL}`,
  };
}
