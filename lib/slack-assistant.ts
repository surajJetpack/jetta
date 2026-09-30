/**
 * Jetta as a colleague you can message in Slack.
 *
 * Read-only by construction. Her ticket toolkit can reply to customers, close
 * tickets, discount and cancel subscriptions — and a Slack DM has no ticket
 * behind it, no draft review and no second pair of eyes, so none of that is
 * reachable from here. The lookups come from lib/assistant-tools.ts, which is
 * built fresh rather than filtered out of `buildTools`.
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
import { readOnlyTools } from "./assistant-tools";
import * as freshdesk from "./tools/freshdesk";
import * as monday from "./tools/monday";
import * as slack from "./tools/slack";
import { linkifyMondayIds, devItemIdsIn } from "./tools/slack";
import { logOpsEvent } from "./events";
import { todayInWords } from "./tz";

const MAX_STEPS = 8;

const SYSTEM = `You are Jetta, the AI support agent for Jetpack Apps and GetSign, talking to a COLLEAGUE in Slack — a member of the support or engineering team, not a customer.

What you are here: a knowledgeable teammate who can look things up fast. You answer questions about tickets, customers, the knowledge base, and your own past decisions.

What you cannot do here, and must not offer or imply you will:
- reply to a customer, close or resolve a ticket, or change anything on a ticket
- apply a discount, extend a trial, or cancel a subscription
- create or update anything on the dev board
If someone asks for one of those, say plainly that it is not something you can do from a chat, and point them at the right route: a typed command in #jetta-escalations, or Freshdesk directly.

You cannot SEE any file. You know an attachment's name, type and size, and how many screenshots were pasted into a message — nothing about what is in them. Never describe or summarise the contents of an image, recording or document, and never infer the problem from a filename.

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
2. Questions about INTAKE — "what came in on Saturday", "how many tickets yesterday", "anything new since Friday" — are search_tickets, which sees the whole queue. recent_activity is only what YOU handled, which is a fraction of it: answering an intake question from your own history undercounts while sounding authoritative. Do not offer it as a substitute.
3. Be brief. Slack, not email. Lead with the answer; add detail only if it changes what they do next.
4. Cite what you used: ticket numbers, article titles, dev item ids. A colleague will want to check you.
5. Name the specific app — GetSign, VLOOKUP Auto-Link, TrackMy — never "Jetpack Apps", which spans nine products and says nothing about where to look.
6. If the tools do not answer it, say so and say what you would need. Do not send someone to the Freshdesk dashboard as your answer — the people who ask you are often the ones without a Freshdesk login, which is why they are asking. Say what you cannot see, not where they should go instead.
7. Do not guess at product behaviour, prices, or what a customer was told. A confident wrong answer to a teammate gets repeated to a customer.
8. No emoji, no preamble, no "great question". Plain sentences.

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

/**
 * Where an answer is being delivered. Taken from the Slack event being
 * answered — never from a model argument.
 */
export interface Delivery {
  channel: string;
  threadTs?: string;
  /** Slack user id of whoever asked, for the audit trail. */
  userId?: string;
}

/**
 * Read-only tools, plus — when there is a conversation to deliver into — the
 * one that hands over a ticket's files.
 *
 * That upload is the only thing here that writes anywhere, and it is bounded by
 * construction rather than by instruction: the destination is closed over from
 * the event being answered, so the model chooses WHICH files to send and never
 * WHERE. A prompt injected through a ticket body can at worst make her re-send
 * a file into the thread the asker is already reading.
 */
function assistantTools(delivery?: Delivery): ToolSet {
  return {
    ...(delivery ? fileDeliveryTool(delivery) : {}),
    ...readOnlyTools(),
  };
}

/**
 * Hand a ticket's files to the person asking.
 *
 * Built only when there is a conversation to deliver into, and closed over that
 * conversation — the model has no argument for where the files go.
 */
function fileDeliveryTool(delivery: Delivery): ToolSet {
  return {
    send_ticket_files: tool({
      description:
        "Upload a ticket's files into THIS Slack conversation: screenshots, screen recordings, documents. Use when someone asks to see, be sent, or be shown what was attached. You still cannot open the files yourself — send them, then say what you sent, and never describe what is in them. Names and ids come from get_ticket_thread or look_up_ticket.",
      inputSchema: z.object({
        ticket_id: z.string().describe("The ticket number, digits only."),
        files: z
          .array(z.string())
          .optional()
          .describe(
            "Exact file names (or attachment ids) to send. Omit to send everything attached to the ticket.",
          ),
        include_pasted_screenshots: z
          .boolean()
          .optional()
          .describe(
            "Also send images pasted into message bodies. These have no filename, so they can only be requested this way. Default false.",
          ),
      }),
      execute: async ({ ticket_id, files, include_pasted_screenshots }) => {
        let fetched;
        try {
          fetched = await freshdesk.downloadTicketFiles(ticket_id, {
            wanted: files,
            includePasted: include_pasted_screenshots,
          });
        } catch (e) {
          return `Could not fetch the files from Freshdesk: ${e instanceof Error ? e.message : String(e)}`;
        }

        if (!fetched.files.length) {
          const why = fetched.skipped.length
            ? fetched.skipped.map((s) => `${s.name} — ${s.reason}`).join("; ")
            : "the ticket has no attachments" +
              (include_pasted_screenshots ? "" : " (pasted screenshots are not included unless you ask for them)");
          return `Nothing was sent. ${why}`;
        }

        const outcome = await slack.uploadFiles(
          delivery.channel,
          delivery.threadTs,
          fetched.files,
          `From ticket #${ticket_id}`,
        );

        // Who pulled which customer files out of Freshdesk, and when. DMs have
        // no witness by design, and the workspace is not gated — so the record
        // is the only thing that makes this reviewable afterwards.
        await logOpsEvent({
          level: outcome.uploaded.length ? "info" : "warn",
          event: "slack.ticket_files_sent",
          source: "slack",
          actor: delivery.userId,
          ticketId: ticket_id,
          data: {
            uploaded: outcome.uploaded,
            failed: outcome.failed.map((f) => `${f.name}: ${f.reason}`),
            channel: delivery.channel,
          },
        });

        const problems = [...fetched.skipped, ...outcome.failed];
        if (!outcome.uploaded.length) {
          return `Nothing was sent: ${problems.map((p) => `${p.name} — ${p.reason}`).join("; ")}`;
        }
        return [
          // Prescriptive to the point of dictating the sentence, because the
          // looser wording produced "two cropped images and one screenshot" —
          // a distinction invented entirely from the filenames, about images
          // she has never seen.
          `Uploaded into this conversation: ${outcome.uploaded.join(", ")}. They are visible above your reply. Answer with ONE short sentence giving the number of files and the ticket. Do not list them, do not characterise them, do not say what they show or when they were taken — you have not seen them and the filenames are not evidence.`,
          problems.length
            ? `Not sent, and you must say so: ${problems.map((p) => `${p.name} — ${p.reason}`).join("; ")}`
            : "",
        ]
          .filter(Boolean)
          .join(" ");
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
 *
 * `delivery` is the conversation the answer is going back into. Without it she
 * can still answer everything — she simply has no way to hand over a file, and
 * is told so rather than left to promise one.
 */
export async function answerInSlack(
  messages: ModelMessage[],
  delivery?: Delivery,
): Promise<SlackAnswer> {
  // Classified on the latest user turn — each message is judged on its own, so
  // a "thanks" at the end of a long investigation is still cheap.
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const tier = tierForMessage(typeof lastUser?.content === "string" ? lastUser.content : "");
  const result = await generateText({
    model: getModel(tier),
    // Today's date is injected rather than assumed: without it "this weekend"
    // and "yesterday" resolve against whenever the model was trained, and a
    // date range is the one tool argument where being quietly wrong produces a
    // confident, plausible, empty answer.
    system: `${SYSTEM}\n\nToday is ${todayInWords()}. Resolve every relative date — "this weekend", "yesterday", "since Friday" — against that, in that timezone.\n\n${
      // Stated here rather than in the static prompt because it is conditional
      // on there being a conversation to upload into. Telling her she can send
      // files when the tool was never built is how a colleague ends up waiting
      // on an attachment that was never coming.
      delivery
        ? "You CAN send a ticket's files into this conversation with send_ticket_files — attachments, and screenshots pasted into a message. Do it when asked instead of pointing anyone at Freshdesk; many of the people who ask you have no Freshdesk login. You still cannot see the files you send."
        : "You have no way to send a file in this context. Say that plainly if asked, and do not offer to share, attach or pull one up."
    }\n\nThe Freshdesk domain is ${config.freshdesk.domain ?? "jetpackwork.freshdesk.com"}; link tickets as <https://${config.freshdesk.domain ?? "jetpackwork.freshdesk.com"}/a/tickets/ID|#ID>.`,
    messages,
    // No tools on the cheap path: small talk has nothing to look up, and
    // withholding them removes any chance of it wandering into a lookup that
    // would cost more than the tier saved.
    ...(tier === "standard"
      ? {
          tools: assistantTools(delivery),
          stopWhen: (s: { steps: unknown[] }) => s.steps.length >= MAX_STEPS,
        }
      : {}),
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
  { title: "Weekend intake", message: "What tickets came in over the weekend?" },
  { title: "Check the knowledge base", message: "What does the KB say about VLOOKUP authorization errors?" },
  { title: "What did the devs say?", message: "What have engineering said on the dev item for ticket #13955?" },
];
