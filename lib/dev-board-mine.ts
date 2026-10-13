/**
 * Reads the conversation on a client-issue dev item and says what it taught.
 *
 * The boards hold the team's best product knowledge and nobody reads it twice:
 * the "Root Cause" column is never filled, and the answer to "why does the
 * Status column not show in the trigger dropdown" lives in a reply from a
 * developer three weeks ago. The handoff audit (2026-09-24) found 26 of 115
 * handoffs were facts the KB didn't have — most of them answered on an item.
 *
 * One LLM call per item, re-run only when its thread or outcome moves
 * (threadHash). The judge model, not the drafting one: these labels decide
 * what the page tells people about their own work.
 *
 * Nothing here writes to monday or the KB. A lesson becomes a KB draft only
 * when a person presses the button on /dev-board.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { judgeModel, JUDGE_MODEL } from "./judge";
import { vectorEnabled, queryVector } from "./vector";
import { searchPublishedKb } from "./kb-store";
import { FRICTIONS, MINED_KINDS, type MinedItem } from "./dev-board";

const MinedSchema = z.object({
  kind: z
    .enum(MINED_KINDS)
    .describe(
      "What the issue turned out to be, judged from how it ENDED: bug = engineering changed code or data to fix it; usage_or_setup = the product worked, the customer set it up or used it wrong; knowledge_gap = support only needed a fact engineering knew; feature_request = asked for something the product never did; account_or_billing = plan, credits, access; not_an_issue = could not replicate or works as designed; unclear = the thread does not say.",
    ),
  app: z.string().describe("The app as customers know it: GetSign, VLOOKUP Auto-Link, TrackMy, Smart Columns, Extract, Jobflows, Triggerly… Never 'Jetpack Apps'."),
  area: z
    .string()
    .describe("2 to 4 words naming the part of the app (e.g. 'PDF generation trigger', 'Signer emails'). Reuse a KNOWN AREA, spelled exactly the same, ONLY when this item is about that same part of the app; a merely related area is a new one."),
  rootCause: z.string().describe("One sentence: why it happened, as engineering explained it. Empty string if nobody said."),
  resolution: z.string().describe("One sentence: what was done, or where it stands if not resolved. Empty string if unknown."),
  lesson: z
    .string()
    .describe(
      "The fact or workaround a support agent could tell the NEXT customer with this problem, without asking engineering, in plain customer-facing words. Empty string if the only answer was a code fix or the thread doesn't say.",
    ),
  kbWorthy: z
    .boolean()
    .describe("True only if `lesson` is a reusable, customer-safe fact likely to come up again — not a one-off account fix, not 'we fixed a bug'."),
  kbTitle: z.string().describe("If kbWorthy, a help-article title phrased as the customer's question or problem. Else empty string."),
  friction: z
    .array(z.enum(FRICTIONS))
    .describe(
      "0 to 3 things that made this item slower than it needed to be, ONLY when the thread shows them: missing_info = engineering had to ask for repro steps, account, or screenshots; slow_engineering_reply = support waited days for engineering; slow_support_reply = engineering waited days for support; fix_failed_testing = a fix came back; customer_unresponsive = it stalled on the customer; unclear_ownership = passed between people or nobody picked it up.",
    ),
});

const SYSTEM = `You read the conversation on one item from a software team's monday.com dev board and record what it taught, for the support team's knowledge and for spotting recurring problems.

The team makes monday.com marketplace apps: GetSign (e-signature) and the Jetpack Apps (VLOOKUP Auto-Link, TrackMy, Smart Columns, Extract, Jobflows, Triggerly and others). Support people (marked "support") file customer problems on the board; "Jetta" is the AI support agent, which files some items itself with the customer's report; everyone else is engineering, QA, design or a lead.

Rules:
- Use only what the thread says. Do not guess a root cause; leave it empty instead.
- Judge kind by the outcome, not by how it was filed: many items filed as bugs end as setup problems or a fact support didn't know.
- The lesson is for a customer, in customer words. Never include names of staff, internal links, board or item ids, logins, passwords, emails or account URLs.
- Short. One sentence per field.`;

export interface MineInput {
  itemId: string;
  thread: string;
  /** Areas already used for this app — the miner reuses them so patterns can show. */
  knownAreas: string[];
  hash: string;
}

/** Above this the closest published article is taken to cover the lesson. */
const KB_COVERED_VECTOR = 0.8;
const KB_COVERED_KEYWORD = 9;

async function closestArticle(text: string): Promise<MinedItem["kb"]> {
  if (!text.trim()) return null;
  if (vectorEnabled()) {
    const hit = (await queryVector(text, 1).catch(() => []))[0];
    return hit && hit.score >= KB_COVERED_VECTOR ? { id: hit.id, title: hit.title, score: +hit.score.toFixed(3) } : null;
  }
  const hit = (await searchPublishedKb(text, 1).catch(() => []))[0];
  return hit && (hit.score ?? 0) >= KB_COVERED_KEYWORD ? { id: hit.id, title: hit.title, score: hit.score ?? 0 } : null;
}

export async function mineItem(input: MineInput): Promise<MinedItem> {
  const call = () =>
    generateObject({
      model: judgeModel(),
      schema: MinedSchema,
      system: SYSTEM,
      maxOutputTokens: 2000,
      prompt: [
        `KNOWN AREAS for this app (reuse when one fits): ${input.knownAreas.length ? input.knownAreas.map((a) => `"${a}"`).join(", ") : "(none yet)"}`,
        "",
        "THE ITEM AND ITS CONVERSATION, oldest first:",
        input.thread.slice(0, 14_000),
      ].join("\n"),
    });
  // One retry: about 1 call in 25 came back unparseable on 2026-10-13, and the
  // same item parsed fine on the next try.
  const { object } = await call().catch(() => call());
  const lesson = object.lesson.trim() || null;
  const kbTitle = object.kbTitle.trim() || null;
  const kbWorthy = object.kbWorthy && !!lesson;
  return {
    hash: input.hash,
    at: Date.now(),
    model: JUDGE_MODEL,
    kind: object.kind,
    app: object.app.trim(),
    area: object.area.trim(),
    rootCause: object.rootCause.trim() || null,
    resolution: object.resolution.trim() || null,
    lesson,
    kbWorthy,
    kbTitle,
    friction: [...new Set(object.friction)].slice(0, 3),
    kb: kbWorthy ? await closestArticle(`${kbTitle ?? ""}\n${lesson}`) : null,
  };
}
