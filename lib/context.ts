/**
 * Context assembly: pull together the ticket, the customer's FastSpring account,
 * and any existing monday.com Dev items, then shape the conversation history
 * into the message array handed to the Claude loop.
 */
import { generateObject, type ModelMessage } from "ai";
import { z } from "zod";
import type {
  AppProduct,
  ConversationContext,
  Product,
  ProductSource,
  RunChannel,
  TaskUsage,
  Ticket,
} from "./types";
import { config } from "./config";
import { getModel, modelLabel } from "./llm";
import * as freshdesk from "./tools/freshdesk";
import * as freshchat from "./tools/freshchat";
import * as jettachat from "./tools/jettachat";
import * as chatStore from "./chat-store";
import { getChatSettings, publicSettings } from "./chat-settings";
import { chatBrandKey } from "./profiles";
import * as fastspring from "./tools/fastspring";
import * as monday from "./tools/monday";
import { getKnownTopics, recordTopicUse } from "./kv";
import { normalizeTopic } from "./topics";
import {
  activeReleaseWatches,
  recordReleaseMention,
  releaseMentionSchema,
  releaseWatchPrompt,
  verifyReleaseEvidence,
  type ReleaseMentionKind,
} from "./release-watch";

// Context-diet caps for the replayed conversation (lib/tools/freshdesk.ts has
// the equivalent caps for the get_ticket_details tool result).
//
// Aligned with freshdesk.ts's MAX_REPLIES so the replay isn't tighter than what
// the tool already fetched. Measured over 19 recent tickets: 21% have more than
// 12 public replies, none have more than 20 (max seen 15), and 12 → 20 adds ~43
// tokens of history on average. Raising it past 20 would add nothing.
const MAX_HISTORY_REPLIES = 20;
const REPLY_CHARS = 2000;
const OPENING_CHARS = 4000;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[…truncated]` : text;
}

/**
 * App-name patterns, tolerant of how customers actually type them.
 *
 * Every name here is a compound word that people space out or hyphenate at
 * will: "V lookup Not responding", "Purchase of Get Sign", "Track My". The
 * original patterns matched only the closed-up spelling, so those tickets
 * attributed to nothing — measured at 71% unresolved across 190 real tickets.
 */
const APP_PATTERNS = {
  // "e-sign" needs a leading word boundary: without it the pattern matches the
  // "e" + "sign" inside DESIGN, redesign, designer and resign, quietly filing
  // any ticket about design work under GetSign. Bare "mapping" is gone for the
  // same reason — column and field mapping are VLOOKUP and Extract concepts at
  // least as often as they are GetSign ones, so it goes to triage to decide.
  getsign: /get\s*-?\s*sign|\be-?\s?sign|signature|signatory|\bsigner/,
  trackmy: /track\s*-?\s*my|courier|parcel|shipment tracking|tracking number/,
  vlookup: /v\s*-?\s*lookup/,
  extract: /extract\s*-?\s*ai|\bextract\b/,
  jobflows: /job\s*-?\s*flows?/,
  smartcolumns: /smart\s*-?\s*columns?/,
  jetscan: /jet\s*-?\s*scan/,
  pivotreports: /pivot\s*-?\s*reports?/,
  triggerly: /triggerly|qr code/,
} as const satisfies Record<Exclude<AppProduct, "unknown">, RegExp>;

/** Cheap heuristic to attribute a ticket to a product. */
export function inferProduct(text: string): Product {
  const t = text.toLowerCase();
  if (APP_PATTERNS.getsign.test(t)) return "getsign";
  if (/jetpack|marketplace|widget/.test(t)) return "jetpackapps";
  for (const [app, re] of Object.entries(APP_PATTERNS)) {
    if (app !== "getsign" && re.test(t)) return "jetpackapps";
  }
  if (/monday\.com|board/.test(t)) return "jetpackapps";
  return "unknown";
}

/**
 * Freshdesk's cf_product custom field is ground truth when agents set it.
 * Dropdown values (from the FD ticket form): VLOOKUP Auto-link, Extract,
 * TrackMy, GetSign, JetScan HR, Triggerly, Pivot Reports Pro, Jobflows,
 * Smart Columns, Offsite, Other/ General. "Other/ General" is explicitly
 * not-a-product — fall through to the heuristics for those.
 */
export function productFromHint(hint: string | null | undefined): Product | null {
  const h = hint?.trim().toLowerCase();
  if (!h || /other|general/.test(h)) return null;
  return /getsign/.test(h) ? "getsign" : "jetpackapps";
}

/**
 * Cheap heuristic to attribute a ticket to the *specific* monday.com app it
 * concerns — finer-grained than `inferProduct`, since each app bills through
 * its own separate FastSpring store (confirmed 2026-07-20: VLOOKUP and
 * TrackMy are already two distinct stores, not one shared "jetpackapps" one).
 */
export function inferAppProduct(text: string): AppProduct {
  const t = text.toLowerCase();
  // Order matters: getsign first (its "signature"/"mapping" terms are the most
  // generic), then the rest by how specific their names are.
  for (const app of [
    "getsign", "trackmy", "vlookup", "jobflows", "smartcolumns", "jetscan", "pivotreports", "triggerly", "extract",
  ] as const) {
    if (APP_PATTERNS[app].test(t)) return app;
  }
  return "unknown";
}

/**
 * Freshdesk cf_product dropdown value → AppProduct. Same ground-truth
 * precedence as `productFromHint`, at the finer per-app grain FastSpring
 * routing needs.
 */
export function appProductFromHint(hint: string | null | undefined): AppProduct | null {
  const h = hint?.trim().toLowerCase();
  if (!h || /other|general/.test(h)) return null;
  if (/getsign/.test(h)) return "getsign";
  if (/vlookup/.test(h)) return "vlookup";
  if (/trackmy/.test(h)) return "trackmy";
  if (/extract/.test(h)) return "extract";
  if (/jobflow/.test(h)) return "jobflows";
  if (/smart column/.test(h)) return "smartcolumns";
  if (/jetscan/.test(h)) return "jetscan";
  if (/pivot report/.test(h)) return "pivotreports";
  if (/triggerly/.test(h)) return "triggerly";
  return null;
}

const TRIAGE_SYSTEM = `You triage customer support tickets: classify the intake type, attribute them to a product, rate their complexity, and label the theme.

Intake type — is this a real customer who needs a reply, or noise?
- "customer_query" — an actual person asking a question, reporting a problem, or making a request. This is the DEFAULT: when there is any genuine human message to respond to, choose this even if it is short or vague.
- "auto_reply" — an automated response with no human intent: out-of-office / vacation autoresponders, "I am away" messages, delivery-failure / bounce / undeliverable notices, read receipts.
- "marketing" — promotional / bulk mail, newsletters, sales outreach, cold pitches, notifications from other services. Not a support request.
- "spam" — junk, phishing, or clearly irrelevant content.
- "other" — none of the above and clearly not something to reply to.
Only pick a non-"customer_query" type when you are confident. If in doubt, choose "customer_query".

Products:
- "getsign" — GetSign (getsign.io), the e-signature app for monday.com: signing documents, signature requests, templates, field mapping, signed-document sync.
- "jetpackapps" — Jetpack Apps (jetpackapps.io), the monday.com marketplace app portfolio: TrackMy (parcel/courier tracking), VLOOKUP Auto-Link (connect/sync boards), Extract AI (pull data from files/emails into boards), JobFlows (recruiting), Smart Columns (currency converter, mandatory fields, SLA, duplicates, custom IDs, conditional status and other column utilities), JetScan HR (resume scanning), Pivot Reports Pro, Triggerly (QR codes).
- "unknown" — genuinely impossible to tell from the text (pure billing/account questions with no product hints, empty tickets).

Pick the single most likely product from the ticket's content and phrasing. Prefer a product over "unknown" when the text leans one way, even without an explicit product name.

App — WHICH app, specifically. "jetpackapps" is a portfolio of separate apps, so naming it alone is useless for spotting which app is having a bad week. Attribute by what the ticket describes, not just by a name it mentions:
- "getsign" — GetSign, the e-signature app (its own product with its own site, getsign.io): signature requests, signers and signing order, signing links, templates, field mapping onto a document, generated/signed PDFs, where signed documents are stored.
- "vlookup" — VLOOKUP Auto-Link: connecting/matching items between boards, auto-linking, copy & sync between boards, lookup or mirror columns not updating.
- "trackmy" — TrackMy: parcel/courier/shipment tracking, tracking numbers, carrier status.
- "extract" — Extract AI: pulling data out of files, PDFs or emails into board columns.
- "jobflows" — JobFlows: recruiting pipelines, candidates, job postings, hiring boards.
- "smartcolumns" — Smart Columns: currency conversion, mandatory fields, SLA timers, duplicate detection, custom IDs, conditional status and similar column utilities.
- "jetscan" — JetScan HR: resume/CV scanning and parsing.
- "pivotreports" — Pivot Reports Pro: pivot tables, cross-tab reporting, report widgets.
- "triggerly" — Triggerly: QR codes, and automations triggered by scanning them.
- "unknown" — only when the ticket really gives nothing to go on: a pure billing, invoice, VAT or account question with no app in sight, or an empty/unintelligible ticket. Also "unknown" for legal, compliance and procurement paperwork addressed to us as a company — DPAs, MSAs, security questionnaires, W-9s, vendor forms. A customer asking us to sign a contract is NOT a GetSign ticket: "signed" there means countersigned by us, not the e-signature product. Only choose "getsign" when the ticket is about USING GetSign.
Choose "unknown" over guessing. A wrong app is worse than no app, because it lands in another app's trend line.

Complexity:
- "simple" — a single, clearly-stated question likely answerable from documentation: a how-to, a pricing/plan question, a plain factual billing lookup.
- "standard" — anything else: multiple issues, technical debugging, error reports, angry or escalation-prone tone, refunds needing judgment, or unclear requests. When in doubt, "standard".

Topic — a short label for what the ticket is ABOUT, used to spot issues trending across many tickets.
- 2 to 4 lowercase words naming the specific problem or request: "signing link expired", "invoice vat number", "board column mapping", "trial extension request".
- Name the theme, not this customer's details: no names, emails, ticket numbers, company names or quoted error strings.
- Not a severity or sentiment ("urgent", "angry customer") and not a restatement of the product name on its own.
- Never a label built only from filler words — "general help", "help needed", "technical issue", "customer request" and the like are worthless for spotting trends. Every label must contain at least one word naming a real surface, feature or action.
- When the subject is vague, read the body for what the customer actually wants. If even the body doesn't say, name the surface it touches ("account access", "billing question") rather than reaching for filler.`;

/**
 * Append the running vocabulary so the model reuses existing labels. Without
 * this the same issue arrives as "signing link expired" one day and "sign url
 * expiry" the next, and the trend maths sees two small topics instead of one
 * real one.
 */
function triageSystem(knownTopics: string[]): string {
  const topicsPart = knownTopics.length
    ? `

Topics already in use, most common first. If one of these fits the ticket, reuse it EXACTLY rather than inventing a near-synonym. Only coin a new label when none of them describes the ticket:
${knownTopics.map((t) => `- ${t}`).join("\n")}`
    : "";
  return `${TRIAGE_SYSTEM}${topicsPart}${releaseWatchPrompt(activeReleaseWatches())}`;
}

export type IntakeType = "customer_query" | "auto_reply" | "marketing" | "spam" | "other";

export interface TicketTriage {
  product: Product;
  /** Which specific app — the grain "jetpackapps" is too coarse to act on. */
  app: AppProduct;
  complexity: "simple" | "standard";
  /** Whether this ticket is a genuine customer query worth drafting for. */
  intake: IntakeType;
  /** Canonical theme label, or undefined when triage failed / produced noise. */
  topic?: string;
  /** Set when the message touches a tracked release (lib/release-watch.ts). */
  release?: { watch: string; kind: ReleaseMentionKind; quote: string; evidence: string } | null;
}

const APP_VALUES = [
  "getsign", "vlookup", "trackmy", "extract", "jobflows",
  "smartcolumns", "jetscan", "pivotreports", "triggerly", "unknown",
] as const;

/**
 * The taxonomy changes slowly and every ticket needs it, so hold it in process
 * for a few minutes rather than paying a KV round-trip per triage.
 */
const TOPIC_CACHE_MS = 10 * 60_000;
let topicCache: { at: number; topics: string[] } | null = null;

async function knownTopics(): Promise<string[]> {
  if (topicCache && Date.now() - topicCache.at < TOPIC_CACHE_MS) return topicCache.topics;
  const topics = await getKnownTopics(40).catch(() => []);
  topicCache = { at: Date.now(), topics };
  return topics;
}

/**
 * One light-model call per ticket: product attribution (fallback when the
 * keyword heuristic can't decide) + a complexity rating used for model
 * routing and analytics. Fails soft to {unknown, standard} — failures must
 * never block a run, and unknown complexity routes to the strong model.
 */
export async function triageTicket(
  subject: string,
  description: string,
  usageSink?: TaskUsage[],
): Promise<TicketTriage> {
  try {
    const watches = activeReleaseWatches();
    const { object, usage } = await generateObject({
      model: getModel("light"),
      schema: z.object({
        intake: z.enum(["customer_query", "auto_reply", "marketing", "spam", "other"]),
        product: z.enum(["getsign", "jetpackapps", "unknown"]),
        app: z.enum(APP_VALUES).describe("The specific app the ticket is about"),
        complexity: z.enum(["simple", "standard"]),
        topic: z.string().describe("2-4 lowercase words naming what the ticket is about"),
        // Only meaningful while a release watch is active — with none, the
        // field degenerates to a constant null (its prompt fragment is gone).
        release: watches.length ? releaseMentionSchema(watches) : z.null(),
      }),
      system: triageSystem(await knownTopics()),
      prompt: `Subject: ${subject}\n\n${description.slice(0, 2000)}`,
    });
    usageSink?.push({
      task: "triage",
      model: modelLabel("light"),
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
    });
    // Only genuine customer queries feed the taxonomy — letting marketing and
    // bounce noise coin topics would pollute the vocabulary shown to triage.
    const topic = normalizeTopic(object.topic) ?? undefined;
    if (topic && object.intake === "customer_query") {
      void recordTopicUse(topic).catch(() => {});
    }
    return { ...object, topic };
  } catch (e) {
    console.warn("Ticket triage failed, using {unknown, standard, customer_query}:", e);
    return { product: "unknown", app: "unknown", complexity: "standard", intake: "customer_query" };
  }
}

/** Back-compat wrapper: product-only triage (used by tests/scripts). */
export async function classifyProduct(subject: string, description: string): Promise<Product> {
  return (await triageTicket(subject, description)).product;
}

/**
 * Assemble full context for a Freshdesk/Freshchat ticket.
 * Account and dev-item lookups are best-effort — a failure there shouldn't block
 * Jetta from replying.
 */
export async function buildContext(
  ticketId: string,
  channel: RunChannel = "freshdesk",
): Promise<ConversationContext> {
  // JettaChat carries visitor identity no other channel has (the monday
  // account the widget is embedded in), so read the conversation itself and
  // derive the ticket from it, rather than adapting and losing the extras.
  const chatConv = channel === "jettachat" ? await chatStore.getConversation(ticketId) : null;
  if (channel === "jettachat" && !chatConv) {
    throw new Error(`JettaChat conversation ${ticketId} not found (expired?)`);
  }

  const ticket =
    channel === "freshchat"
      ? await freshchat.getConversationAsTicket(ticketId)
      : chatConv
        ? jettachat.conversationToTicket(chatConv)
        : await freshdesk.getTicketDetails(ticketId);
  // Triage runs for every live ticket (keyed to the channel's live flag, not
  // global STUB_MODE, so staged rollouts work) — in parallel with the account
  // and dev-item lookups so its latency hides behind them.
  //
  // JettaChat has no stub path: the conversation is genuinely ours and every
  // message in it came from a real visitor, so its content is always "live".
  const contentIsLive =
    channel === "freshchat"
      ? config.freshchat.live
      : channel === "jettachat"
        ? true
        : config.freshdesk.live;
  const taskUsage: TaskUsage[] = [];

  // Dev board search needs a product (to pick which board to query) before the
  // async LLM triage below has run. Use the synchronous cf_product/keyword
  // signals only — "unknown" here falls back to the general jetpackapps board.
  const keywordProduct = inferProduct(`${ticket.subject}\n${ticket.description}`);
  const searchProduct = productFromHint(ticket.productHint) ?? keywordProduct;

  // FastSpring lookup needs the specific app (each app has its own store),
  // same synchronous cf_product/keyword precedence as the dev-board search.
  const appProduct =
    appProductFromHint(ticket.productHint) ??
    inferAppProduct(`${ticket.subject}\n${ticket.description}`);

  const [triage, account, relatedDevItems] = await Promise.all([
    contentIsLive
      ? triageTicket(ticket.subject, ticket.description, taskUsage)
      : Promise.resolve<TicketTriage>({
          product: "unknown",
          app: "unknown",
          complexity: "standard",
          intake: "customer_query",
        }),
    ticket.requesterEmail
      ? fastspring.getFastSpringAccount(ticket.requesterEmail, appProduct).catch(() => null)
      : Promise.resolve(null),
    monday
      .searchDevBoard(ticket.subject, searchProduct === "unknown" ? "jetpackapps" : searchProduct)
      .catch(() => []),
  ]);

  // Attribution precedence: Freshdesk's cf_product field (ground truth set by
  // agents/forms) > keyword heuristic > LLM triage fallback.
  const hintProduct = productFromHint(ticket.productHint);
  const product = hintProduct ?? (keywordProduct !== "unknown" ? keywordProduct : triage.product);
  // Only the cf_product field (and, on chat, the embedding page writing into
  // the same field) counts as knowing. Everything below it is a guess, and a
  // guess must never narrow the brand profile's KB scope — see lib/profiles.ts.
  const productSource: ProductSource = hintProduct ? "ground-truth" : "inferred";

  // Same precedence at app grain, for reporting. Deliberately a SEPARATE field
  // from `appProduct` above: that one is computed before triage because the
  // FastSpring prefetch needs it, and it routes billing writes to a specific
  // store. Letting an LLM guess feed store selection could apply a discount
  // against the wrong app's store, so billing keeps the conservative
  // hint/keyword value and only reporting takes the model's fallback.
  const app: AppProduct =
    appProduct !== "unknown" ? appProduct : triage.app;

  // A release-watch hit goes straight to the mention store (fire-and-forget —
  // feedback capture must never delay or fail a run). Keyed per (watch,
  // ticket), so the re-triage on every customer reply updates, not duplicates.
  // The evidence check is the hard gate: the model's claimed feature phrase
  // must literally appear in the message, or the tag is discarded.
  if (
    triage.release &&
    triage.intake === "customer_query" &&
    verifyReleaseEvidence(triage.release.evidence, `${ticket.subject}\n${ticket.description}`)
  ) {
    void recordReleaseMention({
      watchId: triage.release.watch,
      ticketId,
      channel,
      subject: ticket.subject,
      kind: triage.release.kind,
      quote: triage.release.quote,
      app: app !== "unknown" ? app : undefined,
      at: Date.now(),
    }).catch((e) => console.warn("recordReleaseMention failed:", e));
  }

  return {
    channel,
    ticket,
    account,
    relatedDevItems,
    product,
    productSource,
    appProduct,
    app,
    complexity: triage.complexity,
    intake: triage.intake,
    topic: triage.topic,
    taskUsage,
    chat: chatConv
      ? await (async () => {
          const chatSettings = await getChatSettings();
          return {
          surface: chatConv.surface,
          mondayAccountSlug: chatConv.visitor.mondayAccountSlug,
          pageUrl: chatConv.pageUrl,
          handoffEnabled: chatSettings.handoffEnabled,
          // Resolved through the conversation's own brand, because a brand
          // may switch the requirement off (a logged-in monday view already
          // knows who the person is).
          needsIdentity:
            !chatConv.visitor.email &&
            publicSettings(chatSettings, chatBrandKey(chatConv)).requireIdentity,
          // A conversation that already has a ticket is a different job: she
          // keeps answering, but the escalation path is now "add to the
          // existing thread", never "open a second one". Both the tool list
          // and the prompt branch on this one field.
          ticketId: chatConv.ticketId,
          };
        })()
      : undefined,
  };
}

/**
 * Build the conversation message array from the ticket.
 *
 * The opening message carries the ticket subject + description as the customer's
 * first turn. Subsequent public replies are mapped to user/assistant turns;
 * private notes are dropped (they are internal and would confuse the model).
 */
export function buildMessages(ticket: Ticket, channel: RunChannel = "freshdesk"): ModelMessage[] {
  const opening = clip(ticket.description, OPENING_CHARS);
  const openingContent =
    channel === "freshchat"
      ? `[Live chat — handed off to you by the front-line bot]\n\n${opening}`
      : channel === "jettachat"
        ? // No hand-off preamble — on this channel Jetta *is* the front line,
          // so there is no prior bot transcript to read or work around.
          `[Live chat — you are the first responder]\n\n${opening}`
        : `[New ticket]\nSubject: ${ticket.subject}\n\n${opening}`;

  const messages: ModelMessage[] = [{ role: "user", content: openingContent }];

  // Context diet: long threads dominate token spend (the history is re-sent on
  // every tool-loop step). Replay only the newest exchanges; the model can
  // always pull specifics with get_ticket_details.
  const publicReplies = ticket.replies.filter((r) => !r.isPrivate);
  const recent = publicReplies.slice(-MAX_HISTORY_REPLIES);
  if (publicReplies.length > recent.length) {
    messages.push({
      role: "user",
      content: `[system] ${publicReplies.length - recent.length} earlier replies omitted for brevity — use get_ticket_details if you need the full history.`,
    });
  }
  for (const reply of recent) {
    messages.push({
      role: reply.author === "customer" ? "user" : "assistant",
      content: clip(reply.body, REPLY_CHARS),
    });
  }

  // The API requires the conversation to end on a user turn for Jetta to act.
  // If the last public message was Jetta's own, append a nudge so she
  // re-evaluates rather than the request being rejected.
  const last = messages[messages.length - 1];
  if (last.role === "assistant") {
    messages.push({
      role: "user",
      content: "[system] Re-evaluate this ticket and take the next appropriate action.",
    });
  }

  return messages;
}
