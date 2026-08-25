/**
 * Release watch — customer voice on newly shipped features, for the product
 * manager reading /today.
 *
 * A new release needs eyes on what customers actually say about it, and a
 * keyword grep over subjects undercounts badly: nobody writes "MCP", they
 * write "the Claude thing" or "the new view in my board". So detection rides
 * the per-ticket triage call (lib/context.ts) — the light model already reads
 * every ticket and chat, and tagging a release mention there costs one extra
 * field, not a second pass.
 *
 * Watches are config, not code: the section on /today renders whatever is
 * active here, so the next release is an entry in RELEASE_WATCHES, not a new
 * feature. Mentions are stored per (watch, conversation) in one Redis hash —
 * a rerun of triage on the same ticket overwrites rather than duplicates.
 */
import { Redis } from "@upstash/redis";
import { generateObject } from "ai";
import { z } from "zod";
import { config } from "./config";
import { getModel } from "./llm";

export interface ReleaseWatch {
  /** Stable id — also the value triage writes, so keep it short and unspaced. */
  id: string;
  /** Display name on /today. */
  name: string;
  /**
   * What the triage model matches against: what the feature is, plus the
   * words customers actually use for it. This is the whole detector — write
   * it for a reader who has never seen the release notes.
   */
  description: string;
  /** Counting starts here ("watching since"), not necessarily the ship date. */
  since: string;
  active: boolean;
}

export const RELEASE_WATCHES: ReleaseWatch[] = [
  {
    id: "getsign-board-view",
    name: "GetSign board view",
    description:
      "The NEWLY RELEASED GetSign board view — the redesigned view/tab experience on a monday board. " +
      "Count it ONLY when the customer clearly signals the new experience: they call the view new, redesigned " +
      'or recently added ("the new view", "the new GetSign tab", "since the update the view changed"), contrast ' +
      "it with the old interface, or ask about adding/setting up the new board view itself. " +
      "GetSign has ALWAYS lived on monday boards — do NOT count routine GetSign work that happens to involve a " +
      "board: sending from an item, templates, placeholders, signer columns, automations, generated documents. " +
      "Those are the old product unless the customer says otherwise.",
    since: "2026-08-01",
    active: true,
  },
  {
    id: "getsign-mcp",
    name: "GetSign MCP (AI assistant)",
    description:
      "The NEWLY RELEASED GetSign MCP server — driving GetSign FROM an AI assistant (Claude, ChatGPT or " +
      'another agent): connecting GetSign to an AI, or sending signature requests / creating workflows by ' +
      'talking to one. Customers say "MCP", "connect to Claude", "use GetSign from my AI assistant". ' +
      "Do NOT count mentions of OUR support chat or support bot — a customer talking TO an AI about a GetSign " +
      "problem is not using the MCP. Only count customers USING an AI assistant to operate GetSign.",
    since: "2026-08-01",
    active: true,
  },
];

export function activeReleaseWatches(): ReleaseWatch[] {
  return RELEASE_WATCHES.filter((w) => w.active);
}

/**
 * What kind of customer voice this is. The split is the load-bearing part for
 * a PM: how-to and confusion are docs/UX findings, bug is engineering,
 * feature-request is roadmap, praise is a win worth quoting.
 */
export const RELEASE_MENTION_KINDS = [
  "how-to",
  "bug",
  "confusion",
  "feature-request",
  "praise",
  "other",
] as const;
export type ReleaseMentionKind = (typeof RELEASE_MENTION_KINDS)[number];

export interface ReleaseMention {
  watchId: string;
  /** Freshdesk ticket id, or a chat conversation UUID. */
  ticketId: string;
  channel: string;
  subject: string;
  kind: ReleaseMentionKind;
  /** ONE short line in the customer's own words. */
  quote: string;
  app?: string;
  /** Unix ms when the mention was recorded. */
  at: number;
}

/** The structured fragment triage (and the backfill) asks the model for. */
export function releaseMentionSchema(watches: ReleaseWatch[]) {
  return z
    .object({
      watch: z.enum(watches.map((w) => w.id) as [string, ...string[]]),
      kind: z.enum(RELEASE_MENTION_KINDS),
      quote: z
        .string()
        .describe("ONE short line in the customer's own words saying what they asked or hit"),
    })
    .nullable()
    .describe("Set ONLY when the message genuinely touches a tracked release; otherwise null");
}

/** Prompt fragment describing the active watches, appended to the triage system. */
export function releaseWatchPrompt(watches: ReleaseWatch[]): string {
  if (!watches.length) return "";
  return `

Release watch — recently shipped features we are collecting customer feedback on. If (and ONLY if) the ticket is genuinely about one of these, fill the "release" field; otherwise set it to null. Mentioning the product alone does not count — the message must touch the specific NEW feature, and each entry below says what does NOT count. This feeds a product manager's read of the release: a false match pollutes it, so when unsure, null.
${watches.map((w) => `- id "${w.id}": ${w.description}`).join("\n")}
Kind: "how-to" (asking how to use it), "bug" (it misbehaves), "confusion" (unsure what it is or does), "feature-request" (asking it to do something it doesn't), "praise", "other".
Quote: one short line in the customer's own words — no names, emails or ticket numbers.`;
}

// ── Storage ─────────────────────────────────────────────────────────
// One hash: field "<watchId>:<ticketId>" → ReleaseMention JSON. Keyed so a
// ticket re-triaged on every customer reply updates its entry in place.

const MENTIONS_KEY = "jetta:release:mentions:v1";

let redis: Redis | null = null;
function client(): Redis | null {
  if (config.kv.url && config.kv.token) {
    redis ??= new Redis({ url: config.kv.url, token: config.kv.token });
    return redis;
  }
  return null;
}
const memMentions = new Map<string, ReleaseMention>();

export async function recordReleaseMention(m: ReleaseMention): Promise<void> {
  const field = `${m.watchId}:${m.ticketId}`;
  const r = client();
  if (r) await r.hset(MENTIONS_KEY, { [field]: m });
  else memMentions.set(field, m);
}

/**
 * Wipe the mention store. Exists because the sweep can only ADD or update
 * entries — a classifier made stricter after a bad run cannot un-record its
 * old false positives, so a rebuild is wipe-then-sweep.
 */
export async function clearReleaseMentions(): Promise<void> {
  const r = client();
  if (r) await r.del(MENTIONS_KEY);
  memMentions.clear();
}

/** All stored mentions for the currently active watches, newest first. */
export async function listReleaseMentions(): Promise<ReleaseMention[]> {
  const r = client();
  const raw = r
    ? ((await r.hgetall<Record<string, ReleaseMention>>(MENTIONS_KEY)) ?? {})
    : Object.fromEntries(memMentions);
  const active = new Set(activeReleaseWatches().map((w) => w.id));
  return Object.values(raw)
    .filter((m) => m && active.has(m.watchId))
    .sort((a, b) => b.at - a.at);
}

/**
 * Standalone classifier for the backfill: same detector the triage call runs,
 * without the rest of triage. Returns null on no match or any failure — a
 * backfill must skip quietly, never crash the sweep.
 */
export async function classifyReleaseMention(
  subject: string,
  body: string,
): Promise<{ watch: string; kind: ReleaseMentionKind; quote: string } | null> {
  const watches = activeReleaseWatches();
  if (!watches.length) return null;
  try {
    const { object } = await generateObject({
      model: getModel("light"),
      schema: z.object({ release: releaseMentionSchema(watches) }),
      system: `You read one customer support message and decide whether it touches a recently shipped feature.${releaseWatchPrompt(watches)}`,
      prompt: `Subject: ${subject}\n\n${body.slice(0, 3000)}`,
    });
    return object.release;
  } catch {
    return null;
  }
}
