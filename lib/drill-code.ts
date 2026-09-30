/**
 * Drill-downs as short, URL-safe codes — `reopened`, `bucket:owes_reply`,
 * `app:getsign:firstReply` — so the ticket list behind a number on /health or
 * /performance can be linked to, not only clicked.
 *
 * Two readers: the pages (`?drill=` opens the sheet on load, so a link pasted
 * into Slack lands on the same list) and the voice assistant, whose navigate
 * tool speaks this syntax. A code that does not parse opens nothing — the page
 * still loads, which is the right failure for a mistyped link.
 *
 * Pure and dependency-free: imported by client components.
 */
import type { Drill } from "./support-health";
import type { PerfDrill } from "./performance";

const HEALTH_SIMPLE = ["tickets", "firstReply", "reopened", "resolved", "backAndForth", "engineering", "drafted"] as const;
const BUCKETS = ["owes_reply", "engineering", "in_progress", "customer"] as const;
const HEALTH_WEEK = ["tickets", "within", "firstReply", "reopened"] as const;
const HEALTH_APP = ["tickets", "firstReply", "reopened", "open", "owesReply", "bugs", "gaps"] as const;

const PERF_SIMPLE = ["coverage", "used", "firstReply", "link", "reopened"] as const;
const PERF_WEEK = ["drafts", "firstReply", "answered"] as const;
const PERF_AGENT = ["firstReplies", "afterSuggestion"] as const;
const HANDOFF_BUCKETS = ["total", "real_bug", "knowledge_gap", "other", "awaiting"] as const;
const HANDOFF_ROUTES = ["dev_item", "slack", "chat"] as const;

const WEEK = /^\d{4}-\d{2}-\d{2}$/;
const one = <T extends string>(list: readonly T[], v: string | undefined): v is T => !!v && (list as readonly string[]).includes(v);

/** The grammar, for the model's tool description. */
export const HEALTH_DRILL_SYNTAX = `${HEALTH_SIMPLE.join(" | ")} | within:<hours> | bucket:<${BUCKETS.join("|")}> | week:<YYYY-MM-DD>:<${HEALTH_WEEK.join("|")}> | app:<app id>:<${HEALTH_APP.join("|")}> | topic:<theme text>`;
export const PERF_DRILL_SYNTAX = `${PERF_SIMPLE.join(" | ")} | week:<YYYY-MM-DD>:<${PERF_WEEK.join("|")}> | agent:<agent name>:<${PERF_AGENT.join("|")}> | handoffs:<${HANDOFF_BUCKETS.join("|")}>:<recent|all>[:<${HANDOFF_ROUTES.join("|")}>][:<YYYY-MM-DD week>]`;

export function encodeHealthDrill(d: Drill): string {
  switch (d.kind) {
    case "within":
      return `within:${d.hours}`;
    case "bucket":
      return `bucket:${d.bucket}`;
    case "week":
      return `week:${d.week}:${d.metric}`;
    case "app":
      return `app:${d.app}:${d.metric}`;
    case "topic":
      return `topic:${d.topic}`;
    default:
      return d.kind;
  }
}

export function decodeHealthDrill(code: string | null | undefined): Drill | null {
  if (!code) return null;
  const [kind, a, ...rest] = code.split(":");
  const b = rest.join(":");
  if (one(HEALTH_SIMPLE, kind) && a === undefined) return { kind } as Drill;
  if (kind === "within" && a && Number(a) > 0) return { kind, hours: Number(a) };
  if (kind === "bucket" && one(BUCKETS, a)) return { kind, bucket: a };
  if (kind === "week" && a && WEEK.test(a) && one(HEALTH_WEEK, b)) return { kind, week: a, metric: b };
  if (kind === "app" && a && one(HEALTH_APP, b)) return { kind, app: a, metric: b };
  // A theme can itself contain a colon; everything after "topic:" is the theme.
  if (kind === "topic" && a) return { kind, topic: code.slice("topic:".length) };
  return null;
}

export function encodePerfDrill(d: PerfDrill): string {
  switch (d.kind) {
    case "week":
      return `week:${d.week}:${d.metric}`;
    case "agent":
      return `agent:${d.agent}:${d.metric}`;
    case "handoffs":
      return `handoffs:${d.bucket}:${d.scope}${d.route ? `:${d.route}` : ""}${d.week ? `:${d.week}` : ""}`;
    default:
      return d.kind;
  }
}

export function decodePerfDrill(code: string | null | undefined): PerfDrill | null {
  if (!code) return null;
  const parts = code.split(":");
  const [kind, a, b] = parts;
  if (one(PERF_SIMPLE, kind) && a === undefined) return { kind } as PerfDrill;
  if (kind === "week" && a && WEEK.test(a) && one(PERF_WEEK, b)) return { kind, week: a, metric: b };
  if (kind === "agent" && a && one(PERF_AGENT, b)) return { kind, agent: a, metric: b };
  if (kind === "handoffs" && one(HANDOFF_BUCKETS, a) && (b === "recent" || b === "all")) {
    const extra = parts.slice(3);
    const week = extra.find((x) => WEEK.test(x));
    const route = extra.find((x) => one(HANDOFF_ROUTES, x));
    return {
      kind,
      bucket: a as Extract<PerfDrill, { kind: "handoffs" }>["bucket"],
      scope: b,
      ...(route ? { route: route as Extract<PerfDrill, { kind: "handoffs" }>["route"] } : {}),
      ...(week ? { week } : {}),
    };
  }
  return null;
}

/** A console link that opens a page's drill sheet. */
export function drillHref(page: "/health" | "/performance", code: string, title?: string): string {
  const q = new URLSearchParams({ drill: code, ...(title ? { title } : {}) });
  return `${page}?${q}`;
}
