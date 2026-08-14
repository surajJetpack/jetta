/**
 * Jetta as a colleague you can message in Slack.
 *
 * Read-only by construction. Her ticket toolkit can reply to customers, close
 * tickets, discount and cancel subscriptions — and a Slack DM has no ticket
 * behind it, no draft review and no second pair of eyes, so none of that is
 * reachable from here. The tools below are built fresh rather than filtered out
 * of `buildTools`: a filter is one careless edit away from letting a write tool
 * back in, whereas a tool that was never constructed cannot be called.
 *
 * Privileged actions still exist — they stay on the typed `@Jetta …` commands
 * in the escalation channel, where colleagues can see them happen.
 *
 * The retrieval here is deliberately the SAME path the ticket agent uses
 * (vector + rerank, keyword fallback), so an answer she gives in Slack is
 * grounded in exactly what she would have used on a ticket. If the two
 * diverged, "why did Jetta say that?" would stop being answerable in Slack.
 */
import { generateText, tool, type ModelMessage, type ToolSet } from "ai";
import { z } from "zod";
import { getModel, modelLabel } from "./llm";
import { config } from "./config";
import { searchPublishedKb } from "./kb-store";
import { queryVector, vectorEnabled, type VectorHit } from "./vector";
import { rerankHits } from "./rerank";
import { getRunLogsByTicket, getOutcomes } from "./kv";
import { appName } from "./types";
import * as freshdesk from "./tools/freshdesk";
import * as fastspring from "./tools/fastspring";
import * as monday from "./tools/monday";
import { linkifyMondayIds, devItemIdsIn } from "./tools/slack";

const MAX_STEPS = 8;
/** Keep tool results small: the whole transcript is re-sent on every step. */
const BODY_CHARS = 1200;

const SYSTEM = `You are Jetta, the AI support agent for Jetpack Apps and GetSign, talking to a COLLEAGUE in Slack — a member of the support or engineering team, not a customer.

What you are here: a knowledgeable teammate who can look things up fast. You answer questions about tickets, customers, the knowledge base, and your own past decisions.

What you cannot do here, and must not offer or imply you will:
- reply to a customer, close or resolve a ticket, or change anything on a ticket
- apply a discount, extend a trial, or cancel a subscription
- create or update anything on the dev board
If someone asks for one of those, say plainly that it is not something you can do from a chat, and point them at the right route: a typed command in #jetta-escalations, or Freshdesk directly.

These are the ONLY commands that exist. Quote them exactly — a command you invent will match nothing and the person will get silence back, which is worse than telling them you don't know:
\`@Jetta status ticket #13955\`
\`@Jetta extend monday trial <app> <account-slug> 14 days\`
\`@Jetta apply monday discount <app> <account-slug> <percent> <days-valid> <monthly|yearly>\`
\`@Jetta approve monet <id>\` / \`@Jetta reject monet <id>\`
\`@Jetta apply discount <subscription-id> to <email>\`  (FastSpring)
\`@Jetta cancel account <email>\`, then \`@Jetta confirm cancel <email>\` from a DIFFERENT admin
\`@Jetta draft kb\` / \`@Jetta publish kb\`  (inside an escalation thread)
If none of them fits what is being asked, say the action has to be done by hand rather than guessing at a command. Never say you have done something you have not done.

How to answer:
1. Look things up before answering. You have tools for tickets, the knowledge base, customer accounts, the dev board (including the comments engineering has left on an item), and your own run history — use them rather than answering from memory.
2. Be brief. Slack, not email. Lead with the answer; add detail only if it changes what they do next.
3. Cite what you used: ticket numbers, article titles, dev item ids. A colleague will want to check you.
4. Name the specific app — GetSign, VLOOKUP Auto-Link, TrackMy — never "Jetpack Apps", which spans nine products and says nothing about where to look.
5. If the tools do not answer it, say so and say what you would need. Do not guess at product behaviour, prices, or what a customer was told. A confident wrong answer to a teammate gets repeated to a customer.
6. No emoji, no preamble, no "great question". Plain sentences.

Formatting: Slack mrkdwn, which is NOT markdown. Bold is *single asterisks*; double asterisks render literally and look broken. No markdown headings. Links are <https://url|label>.`;

/**
 * Slack renders `**bold**` literally, and models reach for markdown by habit
 * however the prompt is worded — so the prompt asks, and this enforces.
 */
export function toSlackMrkdwn(text: string): string {
  return text
    // **bold** → *bold*, leaving genuine maths like 2**3 alone by requiring
    // non-space content between the pairs.
    .replace(/\*\*(?=\S)([^*]+?)(?<=\S)\*\*/g, "*$1*")
    // "## Heading" → "*Heading*": Slack has no headings, and the hashes show.
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*");
}

/** Read-only tools. Nothing here writes anywhere. */
function assistantTools(): ToolSet {
  return {
    look_up_ticket: tool({
      description:
        "Fetch a Freshdesk ticket by number: subject, status, requester, and the full conversation. Use whenever a ticket number is mentioned.",
      inputSchema: z.object({ ticket_id: z.string().describe("The ticket number, digits only.") }),
      execute: async ({ ticket_id }) => {
        const t = await freshdesk.getTicketDetails(ticket_id).catch(() => null);
        if (!t) return `No ticket ${ticket_id} found (or Freshdesk is unavailable).`;
        return JSON.stringify({
          id: t.id,
          subject: t.subject,
          status: t.status,
          requester: t.requesterName ?? t.requesterEmail,
          description: t.description.slice(0, BODY_CHARS),
          replies: t.replies.slice(-6).map((r) => ({
            author: r.author,
            private: r.isPrivate,
            body: r.body.slice(0, 600),
          })),
        });
      },
    }),

    search_knowledge_base: tool({
      description:
        "Search the knowledge base. Returns the top published articles with title, URL and body. Use before answering anything about how a product behaves.",
      inputSchema: z.object({ keyword: z.string().describe("Search terms.") }),
      execute: async ({ keyword }) => {
        const hits = vectorEnabled()
          ? await rerankHits(keyword, await queryVector(keyword, 12).catch(() => [] as VectorHit[]), 5)
          : await searchPublishedKb(keyword, 5).catch(() => []);
        if (!hits.length) return "No knowledge base articles matched. Say so rather than inventing product behaviour.";
        return JSON.stringify(
          hits.map((h) => ({ title: h.title, url: h.url, body: h.body?.slice(0, BODY_CHARS) })),
        );
      },
    }),

    look_up_account: tool({
      description:
        "Look up a customer's billing account by email across the FastSpring stores: plan, status, subscription id.",
      inputSchema: z.object({ email: z.string().describe("Customer email address.") }),
      execute: async ({ email }) => {
        const found = await fastspring.findAccountAcrossStores(email).catch(() => null);
        if (!found) return `No billing account found for ${email}. They may be billed through monday instead.`;
        return JSON.stringify({ app: appName(found.appProduct), account: found.account });
      },
    }),

    search_dev_board: tool({
      description: "Search the monday dev board for open items matching an error or symptom.",
      inputSchema: z.object({
        symptom: z.string().describe("Short description of the error or symptom."),
        product: z.enum(["getsign", "jetpackapps"]).describe("Which board to search."),
      }),
      execute: async ({ symptom, product }) =>
        JSON.stringify(await monday.searchDevBoard(symptom, product).catch(() => [])),
    }),

    read_dev_item_comments: tool({
      description:
        "Read the comments and replies on a monday dev board item — what engineering has actually said about it, newest first. Use for 'what did the devs say', 'any update on that item', or checking whether an escalation has moved. Take the item id from search_dev_board or from a link like /pulses/12790471510.",
      inputSchema: z.object({ item_id: z.string().describe("The dev board item id, digits only.") }),
      execute: async ({ item_id }) => {
        const item = await monday.getItemUpdates(item_id, 15).catch(() => null);
        if (!item) return `No dev board item ${item_id} found (or monday is unavailable).`;
        if (!item.updates.length) {
          return JSON.stringify({
            item: item.name,
            url: item.url,
            note: "The item exists but has no comments yet — nobody has posted an update on it.",
          });
        }
        return JSON.stringify({
          item: item.name,
          url: item.url,
          updates: item.updates.map((u) => ({
            at: u.at,
            author: u.author,
            text: u.text.slice(0, BODY_CHARS),
            replies: u.replies.map((r) => ({ at: r.at, author: r.author, text: r.text.slice(0, 600) })),
          })),
        });
      },
    }),

    my_history_on_ticket: tool({
      description:
        "What YOU did on a ticket previously — which tools you called, whether you replied or escalated, and the reply you wrote. Use for 'why did you…' questions about your own behaviour.",
      inputSchema: z.object({ ticket_id: z.string() }),
      execute: async ({ ticket_id }) => {
        const runs = await getRunLogsByTicket(ticket_id, 5).catch(() => []);
        if (!runs.length) return `No recorded runs for ticket ${ticket_id}.`;
        return JSON.stringify(
          runs.map((r) => ({
            at: new Date(r.at * 1000).toISOString(),
            model: r.model,
            app: r.app,
            topic: r.topic,
            toolsUsed: r.trace?.map((t) => t.tool) ?? [],
            replied: r.replied,
            escalated: r.escalated,
            reply: r.reply?.slice(0, BODY_CHARS),
            error: r.error,
          })),
        );
      },
    }),

    recent_activity: tool({
      description:
        "Recent tickets Jetta handled, newest first — subject, app, topic, and whether it was escalated or reopened. Use for 'what's been happening' or 'anything about X lately' questions.",
      inputSchema: z.object({
        limit: z.number().describe("How many recent tickets to return, 1-50."),
      }),
      execute: async ({ limit }) => {
        const outcomes = await getOutcomes(Math.min(Math.max(limit, 1), 50)).catch(() => []);
        return JSON.stringify(
          outcomes.map((o) => ({
            ticketId: o.ticketId,
            subject: o.subject,
            app: o.app,
            topic: o.topic,
            escalated: o.escalated,
            kind: o.kind,
            at: new Date(o.at * 1000).toISOString(),
          })),
        );
      },
    }),
  };
}

/**
 * Pure pleasantries — the whole message, not merely containing one. Anchored on
 * purpose: "thanks, can you also check 13955?" opens with an acknowledgement but
 * is real work, and must not be answered by the cheap path.
 */
const SMALL_TALK =
  /^(?:hi|hii+|hey+|hello+|yo|hiya|howdy|good (?:morning|afternoon|evening)|morning|afternoon|evening|thanks?|thank you|thx|ta|cheers|ok|okay|k|got it|understood|cool|nice|great|perfect|awesome|lovely|sounds good|no worries|np|bye|goodbye|see ya|later|gm|gn)\b[\s!.,?…\-–—]*$/iu;

/**
 * Which model answers. Small talk needs no lookup and no reasoning, so paying
 * standard-tier latency for it is what made a plain "hello" take 56 seconds —
 * the one complaint the DM surface actually drew on day one.
 *
 * Everything else stays on standard: this is a colleague asking about live
 * customer tickets, and a cheap wrong answer costs far more than the tokens
 * saved. When in doubt it must return "standard".
 */
export function tierForMessage(text: string): "light" | "standard" {
  const t = text.trim().replace(/<@[^>]+>/g, "").trim();
  if (!t) return "light";
  // Strip emoji before matching rather than trying to enumerate them in the
  // pattern: people wave ("Hey 👋") and react ("👍") far more than they
  // punctuate, and an emoji-only message is an acknowledgement too.
  const stripped = t.replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "").trim();
  if (!stripped) return "light";
  return SMALL_TALK.test(stripped) ? "light" : "standard";
}

/**
 * Make the monday ids in an answer clickable.
 *
 * Her tools hand her real URLs, so items she quotes from them arrive linked
 * already — what stays bare are the ids she repeats out of a ticket body, like
 * "source board 5850411194". Those belong to the CUSTOMER's account, which is
 * resolved from the answer's own text; a dev item id is looked up rather than
 * guessed, since a DM could be about either board. Anything unresolvable stays
 * plain, which is the correct outcome — a link into the wrong workspace reads
 * as authoritative and is worse than the number it replaced.
 */
async function linkifyAnswer(text: string, evidence: string): Promise<string> {
  const ids = devItemIdsIn(text);
  const boards = ids.length ? await monday.resolveItemBoards(ids).catch(() => new Map()) : new Map();

  // The customer's monday account is usually in the ticket she just read rather
  // than in the sentence she wrote, so the tool results count as evidence too.
  // Requiring EXACTLY ONE distinct account is what keeps that safe: a
  // conversation covering two customers has no single right answer, and a board
  // id sent to the wrong workspace is worse than the bare number.
  const ourSlug = /https?:\/\/([a-z0-9-]+)\.monday\.com/i.exec(config.monday.accountUrl)?.[1]?.toLowerCase();
  const slugs = new Set(
    [...`${text}\n${evidence}`.matchAll(/https?:\/\/([a-z0-9-]+)\.monday\.com/gi)]
      .map((m) => m[1].toLowerCase())
      .filter((slug) => slug !== ourSlug && slug !== "www"),
  );
  const accountUrl = slugs.size === 1 ? `https://${[...slugs][0]}.monday.com` : undefined;

  return linkifyMondayIds(text, { devBoardId: (id: string) => boards.get(id), accountUrl });
}

export interface SlackAnswer {
  text: string;
  toolsUsed: string[];
  model: string;
  tier: "light" | "standard";
}

/**
 * Answer a Slack conversation. `messages` is the thread so far, oldest first,
 * already mapped to user/assistant roles.
 */
export async function answerInSlack(messages: ModelMessage[]): Promise<SlackAnswer> {
  // Classified on the latest user turn — each message is judged on its own, so
  // a "thanks" at the end of a long investigation is still cheap.
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const tier = tierForMessage(typeof lastUser?.content === "string" ? lastUser.content : "");
  const result = await generateText({
    model: getModel(tier),
    system: `${SYSTEM}\n\nThe Freshdesk domain is ${config.freshdesk.domain ?? "jetpackwork.freshdesk.com"}; link tickets as <https://${config.freshdesk.domain ?? "jetpackwork.freshdesk.com"}/a/tickets/ID|#ID>.`,
    messages,
    // No tools on the cheap path: small talk has nothing to look up, and
    // withholding them removes any chance of it wandering into a lookup that
    // would cost more than the tier saved.
    ...(tier === "standard" ? { tools: assistantTools(), stopWhen: (s: { steps: unknown[] }) => s.steps.length >= MAX_STEPS } : {}),
  });

  const toolsUsed = result.steps.flatMap((s) => s.toolCalls?.map((c) => c.toolName) ?? []);
  // What her tools actually returned — the ticket body that names the customer's
  // monday account lives here, not in the answer.
  const evidence = result.steps
    .flatMap((st) => st.toolResults ?? [])
    .map((r) => {
      try {
        return typeof r.output === "string" ? r.output : JSON.stringify(r.output);
      } catch {
        return "";
      }
    })
    .join("\n");
  const text = await linkifyAnswer(toSlackMrkdwn(result.text.trim()), evidence);
  return {
    // A tool-only final step can leave the text empty; say something rather
    // than posting a blank message into the thread.
    text: text || "I looked but couldn't put an answer together — try rephrasing, or ask me for the ticket directly.",
    toolsUsed,
    model: modelLabel(tier),
    tier,
  };
}

/** Shown when someone opens Jetta's panel with no conversation yet. */
export const SUGGESTED_PROMPTS = [
  { title: "Summarise a ticket", message: "Summarise ticket #13955 and tell me what's blocking it" },
  { title: "What's been happening?", message: "What have the last 10 tickets been about?" },
  { title: "Check the knowledge base", message: "What does the KB say about VLOOKUP authorization errors?" },
  { title: "What did the devs say?", message: "What have engineering said on the dev item for ticket #13955?" },
];
