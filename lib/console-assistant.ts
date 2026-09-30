/**
 * The console assistant — Jetta you can talk to while you use the console.
 *
 * Voice, on Gemini Live. The browser holds the audio socket to Google directly
 * (lower latency than relaying 16 kHz PCM through a function), so this module
 * is everything that must NOT live in the browser:
 *
 *   - the instructions, including what she knows about the system;
 *   - the tool declarations the session is locked to;
 *   - the tools themselves, executed here after the caller is re-checked.
 *
 * Read-only by construction, like the Slack assistant: data tools are the
 * shared lookups in lib/assistant-tools.ts plus console reads below, all built
 * fresh. Voice adds a new way to be misheard, and with monday writes armed in
 * production the only safe number of write tools reachable by speech is zero.
 *
 * Navigation tools are declared here but run in the browser — moving the page
 * is the one "action" she has, and it only changes what the asker is looking at.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { Behavior, type FunctionDeclaration } from "@google/genai";
import { readOnlyTools } from "./assistant-tools";
import { NAV, GUIDE_ITEM, PAGE_SECTIONS } from "@/components/jetta/console-nav";
import {
  capabilityRows,
  channelRows,
  reasoningRows,
  rolloutRows,
  ENDPOINTS,
  CRONS,
  type StatusRow,
} from "./system-status";
import { getOpsEvents, type EventLevel } from "./events";
import { buildTodayBrief } from "./today";
import {
  getSupportHealth,
  getSupportHealthRows,
  getHealthInsight,
  getPerformanceSummary,
  getPerformanceRows,
  getPerformanceInsight,
} from "./performance-sync";
import { buildEvidence, renderHealth } from "./health-insight";
import { buildPerfEvidence, renderPerformance } from "./performance-insight";
import { todayInWords } from "./tz";
import { APP_NAMES } from "./types";
import {
  HEALTH_DRILL_SYNTAX,
  PERF_DRILL_SYNTAX,
  encodeHealthDrill,
  encodePerfDrill,
  drillHref,
} from "./drill-code";
import { config } from "./config";

export type AssistantMode = "live" | "deep";

export const LIVE_MODELS: Record<AssistantMode, string> = {
  live: process.env.JETTA_ASSISTANT_MODEL ?? "gemini-3.8-live",
  deep: process.env.JETTA_ASSISTANT_DEEP_MODEL ?? "gemini-3.8-live-extended-thinking",
};

/** A voice answer is read aloud: a 20 KB tool result is a minute of latency and nothing the listener can use. */
const RESULT_CHARS = 8000;

/**
 * Reference documents she can open on demand. Paths are fixed here, never taken
 * from the model — `doc` is an enum, so the tool cannot be steered into reading
 * an arbitrary file off the server. next.config.ts traces these into the bundle.
 */
const DOCS = {
  manual: "docs/manual/README.md",
  "manual-general": "docs/manual/general.md",
  overview: "JETTA-OVERVIEW.md",
  "support-console-guide": "docs/support-console-guide.md",
  jettachat: "docs/jettachat.md",
} as const;
type DocId = keyof typeof DOCS;

async function readDoc(id: DocId): Promise<string> {
  return readFile(path.join(process.cwd(), DOCS[id]), "utf8").catch(() => `(${DOCS[id]} is not available in this deployment)`);
}

/** The manual split by "## " heading, so she can open one chapter instead of the whole book. */
function section(md: string, wanted?: string): string {
  if (!wanted) return md;
  const parts = md.split(/^(?=## )/m);
  const w = wanted.toLowerCase();
  const hit = parts.filter((p) => p.split("\n")[0].toLowerCase().includes(w));
  return hit.length ? hit.join("\n") : `No section matching "${wanted}". Sections: ${parts.map((p) => p.split("\n")[0].replace(/^#+\s*/, "")).join(" | ")}`;
}

function clip(s: string): string {
  return s.length > RESULT_CHARS ? `${s.slice(0, RESULT_CHARS)}\n…(truncated — ask a narrower question)` : s;
}

/**
 * Every number above, as the drill that lists its tickets — so "show me the
 * reopened ones" becomes navigate(drill=…) or a link, never a description of
 * where to click.
 */
function drillLines(page: "/health" | "/performance", items: { id: string; title: string; code: string }[]): string {
  return [
    `\nDRILL CODES (navigate page=${page === "/health" ? "health" : "performance"} with drill=<code> opens that ticket list; for show_links use the link):`,
    ...items.map((i) => `[${i.id}] ${i.title} → drill=${i.code} · link ${drillHref(page, i.code, i.title)}`),
  ].join("\n");
}

const rowLine = (r: StatusRow) => `- ${r.label}: ${r.state} — ${r.meaning}${r.setting ? ` [${r.setting}]` : ""}`;

/** /system as text: the live truth about what this deployment can do. Pure config, no network. */
function systemStatusText(): string {
  return [
    "CAPABILITIES (write gates):",
    ...capabilityRows().map(rowLine),
    "",
    "CHANNELS:",
    ...channelRows().map(rowLine),
    "",
    "ROLLOUT:",
    ...rolloutRows().map(rowLine),
    "",
    "REASONING (models, retrieval):",
    ...reasoningRows().map(rowLine),
    "",
    "ENTRYPOINTS:",
    ...ENDPOINTS.map((e) => `- ${e.path}: ${e.detail}`),
    "",
    "SCHEDULED JOBS:",
    ...CRONS.map((c) => `- ${c.path} (${c.schedule}): ${c.detail}`),
  ].join("\n");
}

/** Server-side tools: the shared read-only lookups plus console reads. */
export function consoleTools(): ToolSet {
  return {
    ...readOnlyTools(),

    system_status: tool({
      description:
        "The live configuration of this deployment, as shown on /system: which write gates are armed, which channels are live, reply mode, model tiers, retrieval, entrypoints and crons. Use for 'is X switched on', 'what model does Y use', 'can Jetta Z'.",
      inputSchema: z.object({}),
      execute: async () => systemStatusText(),
    }),

    recent_events: tool({
      description:
        "Jetta's operations event log (jetta:events), newest first: webhooks received, runs, escalations, errors, sync jobs. Use for 'did anything fail', 'what happened with ticket N', 'when did the KB sync last run'.",
      inputSchema: z.object({
        event_prefix: z.string().optional().describe('Dot-namespaced prefix, e.g. "webhook", "kb.sync", "chat".'),
        level: z.enum(["info", "warn", "error"]).optional(),
        ticket_id: z.string().optional(),
        hours: z.number().optional().describe("Only events from the last N hours. Default 24."),
        limit: z.number().optional().describe("1-60, default 30."),
      }),
      execute: async ({ event_prefix, level, ticket_id, hours, limit }) => {
        const events = await getOpsEvents({
          event: event_prefix,
          level: level as EventLevel | undefined,
          ticketId: ticket_id,
          sinceMs: Date.now() - (hours ?? 24) * 3_600_000,
          limit: Math.min(Math.max(limit ?? 30, 1), 60),
        }).catch(() => []);
        if (!events.length) return "No events matched in that window.";
        return clip(
          JSON.stringify(
            events.map((e) => ({
              at: new Date(e.at).toISOString(),
              level: e.level,
              event: e.event,
              source: e.source,
              ...(e.ticketId ? { ticket: e.ticketId } : {}),
              ...(e.data ? { data: JSON.stringify(e.data).slice(0, 300) } : {}),
            })),
          ),
        );
      },
    }),

    today_brief: tool({
      description:
        "The /today morning brief: the last 24 hours of tickets Jetta touched, emerging issues and spikes, what needs a person now, open escalations, billing approvals waiting. Use for 'what's going on today', 'anything need me', 'what's spiking'.",
      inputSchema: z.object({}),
      execute: async () => clip(JSON.stringify(await buildTodayBrief())),
    }),

    support_health: tool({
      description:
        "The /health page: team-level support health over the last 28 days — volume, first-reply times against target, who is waiting on a reply, reopens, themes and which apps drive them. Includes the cached AI read if one exists. Use for 'how is support doing', 'who's waiting', 'what's driving volume'.",
      inputSchema: z.object({}),
      execute: async () => {
        const [h, rows, insight] = await Promise.all([
          getSupportHealth(),
          getSupportHealthRows(),
          getHealthInsight<unknown>().catch(() => null),
        ]);
        if (!h || !rows) return "Support health has not been computed yet — the hourly sync has not run.";
        const evidence = buildEvidence(h, rows);
        return clip(
          [
            `Computed ${new Date(h.computedAt).toISOString()}.`,
            renderHealth(h, rows, evidence),
            drillLines("/health", evidence.map((e) => ({ id: e.id, title: e.title, code: encodeHealthDrill(e.drill) }))),
            insight ? `\nCACHED AI READ:\n${JSON.stringify(insight).slice(0, 2500)}` : "",
          ].join("\n"),
        );
      },
    }),

    performance_summary: tool({
      description:
        "The /performance page: what customers got before and after Jetta went live — reply times, how much of the work was Jetta's, handoffs, knowledge gaps (articles that should be written), and per-agent stats. Includes the cached AI read if one exists. Use for 'is Jetta helping', 'what should we document', 'how did first response change'.",
      inputSchema: z.object({}),
      execute: async () => {
        const [s, rows, insight] = await Promise.all([
          getPerformanceSummary(),
          getPerformanceRows(),
          getPerformanceInsight<unknown>().catch(() => null),
        ]);
        if (!s || !rows) return "Performance has not been computed yet — the sync has not run.";
        const evidence = buildPerfEvidence(s, rows);
        return clip(
          [
            `Computed ${new Date(s.computedAt).toISOString()}.`,
            renderPerformance(s, rows, evidence),
            drillLines("/performance", evidence.map((e) => ({ id: e.id, title: e.title, code: encodePerfDrill(e.drill) }))),
            insight ? `\nCACHED AI READ:\n${JSON.stringify(insight).slice(0, 2500)}` : "",
          ].join("\n"),
        );
      },
    }),

    read_doc: tool({
      description:
        "Open Jetta's own documentation. manual = the full console manual (pass `section` to open one chapter, e.g. 'Evals', 'Knowledge Base', 'Slack'); manual-general = the manual for general (non-admin) users; overview = the architecture overview; support-console-guide; jettachat = the chat widget. Use when the summary you already have is not enough.",
      inputSchema: z.object({
        doc: z.enum(Object.keys(DOCS) as [DocId, ...DocId[]]),
        section: z.string().optional().describe("Heading text to match, for the manual."),
      }),
      execute: async ({ doc, section: s }) => clip(section(await readDoc(doc), s)),
    }),
  };
}

/** Names of tools that run in the browser. The server refuses to execute these. */
export const CLIENT_TOOLS = ["navigate", "open_ticket", "show_links", "think_deeper"] as const;

export type ClientToolName = (typeof CLIENT_TOOLS)[number];

/** Every console page id she may send the asker to. */
export function pageIds(): string[] {
  return [...NAV.flatMap((g) => g.items.map((i) => i.id)), GUIDE_ITEM.id];
}

function clientDeclarations(mode: AssistantMode): FunctionDeclaration[] {
  const decls: FunctionDeclaration[] = [
    {
      name: "navigate",
      description:
        "Take the user to a console page — and as precisely as you can: a SECTION of it (scrolls there), or on health/performance a DRILL (opens the list of tickets behind a number). Go to the specific thing they asked about, not just the page. Say where you are taking them in the same breath.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          page: { type: "string", enum: pageIds(), description: "Page id from the CONSOLE MAP." },
          section: { type: "string", description: "Section id on that page, from the CONSOLE MAP." },
          drill: {
            type: "string",
            description: `health or performance only: which ticket list to open. Take the code from the DRILL CODES a support_health / performance_summary lookup returned, or build one — health: ${HEALTH_DRILL_SYNTAX}; performance: ${PERF_DRILL_SYNTAX}.`,
          },
          title: { type: "string", description: "With a drill: a short title for the list, e.g. \"GetSign · reopened\"." },
        },
        required: ["page"],
      },
    },
    {
      name: "show_links",
      description:
        "Put clickable links in the panel: Freshdesk tickets, monday dev items, knowledge-base articles, or console drill links. Use it whenever you mention specific tickets, dev items or articles the user may want to open — you cannot read a URL aloud, so this is how they get it. Use only URLs that a lookup returned (or console links from DRILL CODES); an invented URL is refused. Up to 8 links.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          links: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: 'What it is, e.g. "#14457 · signature status resetting" or "Dev item: sync loop".' },
                url: { type: "string" },
              },
              required: ["label", "url"],
            },
          },
        },
        required: ["links"],
      },
    },
    {
      name: "open_ticket",
      description: "Open a Freshdesk ticket in a new tab for the user.",
      parametersJsonSchema: {
        type: "object",
        properties: { ticket_id: { type: "string", description: "Digits only." } },
        required: ["ticket_id"],
      },
    },
  ];
  if (mode === "live") {
    decls.push({
      name: "think_deeper",
      description:
        "Hand the user's current question to your deep-reasoning mode, which answers it in your place. Use for 'why' questions, root causes, comparisons across weeks or apps, recommendations, or anything that needs several lookups combined and weighed. Call it INSTEAD of answering, and say nothing before calling — the deep mode speaks next. Do not use it for a single lookup, navigation, or a fact you already have.",
      parametersJsonSchema: {
        type: "object",
        properties: { reason: { type: "string", description: "Half a sentence on why this needs reasoning." } },
        required: ["reason"],
      },
    });
  }
  return decls;
}

/**
 * Gemini function declarations for a session. The extended-thinking model
 * accepts NON_BLOCKING calls only (blocking ones are a hard error), which is
 * also what lets it keep talking — "let me check" — while a lookup runs.
 */
export function liveDeclarations(mode: AssistantMode): FunctionDeclaration[] {
  const behavior = mode === "deep" ? Behavior.NON_BLOCKING : Behavior.BLOCKING;
  const server = Object.entries(consoleTools()).map(([name, t]) => {
    const schema = z.toJSONSchema(t.inputSchema as z.ZodType) as Record<string, unknown>;
    delete schema.$schema;
    return { name, description: t.description, parametersJsonSchema: schema, behavior };
  });
  return [...server, ...clientDeclarations(mode).map((d) => ({ ...d, behavior }))];
}

/** The map of the console she navigates by — generated from the nav registry so it can never drift. */
function consoleMap(): string {
  const anchors: Record<string, string> = Object.fromEntries(
    Object.entries(PAGE_SECTIONS).map(([page, secs]) => [
      page,
      `sections: ${Object.entries(secs).map(([id, what]) => `${id} (${what})`).join(", ")}`,
    ]),
  );
  anchors.health += `; drills: ${HEALTH_DRILL_SYNTAX}`;
  anchors.performance += `; drills: ${PERF_DRILL_SYNTAX}`;
  return [
    ...NAV.map(
      (g) =>
        `${g.label}:\n${g.items
          .map((i) => `- ${i.id} (${i.href}) "${i.label}"${i.adminOnly ? " [admin]" : ""}: ${i.hint}${anchors[i.id] ? `; ${anchors[i.id]}` : ""}`)
          .join("\n")}`,
    ),
    `- ${GUIDE_ITEM.id} (${GUIDE_ITEM.href}) "${GUIDE_ITEM.label}": ${GUIDE_ITEM.hint}`,
    "Not in the nav: /drafts (the Suggestions audit trail), /chats/settings (widget settings), /kb/article (one article).",
    `App ids (for drills): ${Object.entries(APP_NAMES).map(([id, name]) => `${id} = ${name}`).join(", ")}.`,
  ].join("\n");
}

const PERSONA = `You are Jetta, the AI support agent for Jetpack Apps and GetSign — and right now you are speaking, by voice, with an ADMIN of your own console: a colleague who runs you, not a customer. You are their guide to the console and to how you yourself work.

What you do here:
- Take them where they need to go (navigate), and explain what they are looking at.
- Answer questions about tickets, customers, the knowledge base, support health, performance, your own configuration and your own past decisions — by looking them up.
- Explain how you work: the pipeline, the safety rails, why a setting exists. You have your manual and your live configuration below; open the full docs with read_doc when that is not enough.

What you cannot do here, and must not offer or imply:
- reply to a customer, close or change a ticket, apply a discount, extend a trial, cancel anything, publish an article, approve a learning, or write to the dev board. You are read-only in this panel. If asked, say so plainly and name the page where they can do it themselves — then offer to take them there.

How to talk:
1. This is speech. Short sentences. Lead with the answer. No lists read aloud unless asked; say "three tickets, the biggest is…" rather than enumerating.
2. Never read out URLs, ids longer than a ticket number, or JSON. Say ticket numbers as numbers.
3. Look things up before answering; never answer about live data from memory. While a lookup runs you may say one short "checking" phrase — never more.
4. Name the specific app — GetSign, VLOOKUP Auto-Link, TrackMy — never "Jetpack Apps", which is nine products.
5. If the tools do not answer it, say what you could not see. Do not guess at numbers, prices, or what a customer was told.
6. When they ask to see something, navigate to the SPECIFIC thing — the section, or the ticket list behind the number (a drill) — not just the page, and say what they will find there in one sentence. "Show me the reopened GetSign tickets" is navigate(page=health, drill=app:getsign:reopened), not the Health page.
7. Links: whenever you talk about specific tickets, dev board items or articles, also call show_links with them, and say "the links are in the panel". Use the URLs your lookups returned; for a list behind a number, the link from DRILL CODES. Do this without being asked when the user would plausibly want to open them.
8. No preamble, no "great question".`;

export interface InstructionContext {
  user: string;
  pathname: string;
  mode: AssistantMode;
}

/**
 * The full system instruction. Locked into the ephemeral token, so the browser
 * cannot swap it for its own.
 */
export async function buildInstructions(ctx: InstructionContext): Promise<string> {
  const [manual, overview] = await Promise.all([readDoc("manual"), readDoc("overview")]);
  return [
    PERSONA,
    `You are talking to "${ctx.user}". They are currently on ${ctx.pathname}. The panel will tell you when they move ("[context] …" messages) — those are not the user speaking; never answer them aloud.`,
    `Today is ${todayInWords()}. Resolve relative dates against that. The Freshdesk domain is ${config.freshdesk.domain ?? "jetpackwork.freshdesk.com"}.`,
    ctx.mode === "deep"
      ? "You are in DEEP mode — the quick mode handed you this question because it needs reasoning. Combine several lookups and reason about causes. Say one short line that you are looking into it, then give the reasoned answer. Do not mention modes or handovers; to the user you are simply Jetta thinking harder."
      : "You are in QUICK mode: answer fast. When a question needs real reasoning across data, call think_deeper instead of answering — you will switch to a slower mode that reasons, and come back afterwards on your own.",
    `CONSOLE MAP (page ids for navigate):\n${consoleMap()}`,
    `LIVE CONFIGURATION (from /system, current as of this session):\n${systemStatusText()}`,
    `ARCHITECTURE OVERVIEW:\n${overview}`,
    `THE CONSOLE MANUAL:\n${manual}`,
  ].join("\n\n");
}

/** Execute a server tool by name. Throws on unknown or client-side names. */
export async function runConsoleTool(name: string, args: unknown): Promise<string> {
  if ((CLIENT_TOOLS as readonly string[]).includes(name)) throw new Error(`${name} runs in the browser`);
  const t = consoleTools()[name];
  if (!t?.execute) throw new Error(`unknown tool ${name}`);
  const input = (t.inputSchema as z.ZodType).parse(args ?? {});
  const out = await t.execute(input, { toolCallId: "live", messages: [] });
  return clip(typeof out === "string" ? out : JSON.stringify(out));
}
