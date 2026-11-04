/**
 * Shapes shared by the self-review cron, its API and the /self-review page.
 * Types only, so the client page can import them without pulling in Redis.
 */

export interface SelfReviewFlag {
  /** Stable id, used to post each flag to Slack once. */
  key: string;
  severity: "bad" | "warn";
  title: string;
  detail: string;
}

export interface CronHealth {
  name: string;
  path: string;
  schedule: string;
  everyMin: number;
  /** unknown = no heartbeat recorded yet (heartbeats started with this feature). */
  state: "ok" | "late" | "failing" | "unknown";
  lastAt?: number;
  okAt?: number;
  status?: number;
  ms?: number;
  failStreak: number;
  lastError?: string;
}

export interface RunHealth {
  runs: number;
  errors: number;
  missedReplies: number;
  escalated: number;
  p50Ms: number;
  p95Ms: number;
  slow: number;
  bySource: { source: string; runs: number; errors: number; p95Ms: number }[];
  baseline: { days: number; runsPerDay: number; errorRate: number; missedRate: number; p95Ms: number };
  recentErrors: { at: number; source: string; ticketId: string; error: string }[];
}

export interface EventCount {
  event: string;
  level: "info" | "warn" | "error";
  count24h: number;
  /** Average per day before the last 24h, or null when the capped list doesn't reach back far enough. */
  perDayBefore: number | null;
  isNew: boolean;
}

export interface ReliabilityReport {
  computedAt: number;
  crons: CronHealth[];
  runs: RunHealth;
  events: { errors24h: number; warns24h: number; spanHours: number; top: EventCount[] };
  flags: SelfReviewFlag[];
}

export type ReplyKind = "chat" | "email" | "dev_bridge";
export type Verdict = "good" | "weak" | "bad";

/** Where Jetta's reply went wrong, as the judge names it. One per finding. */
export const ISSUE_CATEGORIES = [
  "not_answered",
  "unsupported_claim",
  "wrong_info",
  "missed_escalation",
  "needless_escalation",
  "too_long",
  "too_vague",
  "tone",
  "policy",
  "broken_link",
  "internal_leak",
] as const;
export type IssueCategory = (typeof ISSUE_CATEGORIES)[number];

export const FIX_TYPES = ["none", "kb_gap", "prompt", "tool_or_bug", "policy"] as const;
export type FixType = (typeof FIX_TYPES)[number];

export interface JudgedReply {
  runId: string;
  /** Unix ms the run started. */
  at: number;
  judgedAt: number;
  /** Support-timezone day of the run, YYYY-MM-DD. */
  day: string;
  kind: ReplyKind;
  source: string;
  ticketId: string;
  subject?: string;
  app?: string;
  product: string;
  /** The writer's model, from the run log. */
  writer: string;
  judge: string;
  customerAsk: string;
  reply: string;
  escalated: boolean;
  /** Rule checks that need no model: internal links, ticket numbers, dead links, length. */
  checks: string[];
  verdict: Verdict;
  /** 1 (harmful) to 5 (as good as our best agent). */
  score: number;
  answered: "yes" | "partly" | "no";
  grounded: "yes" | "partly" | "no";
  issues: { category: IssueCategory; detail: string }[];
  summary: string;
  fixType: FixType;
  fix: string;
}

export interface DayScore {
  day: string;
  judged: number;
  good: number;
  weak: number;
  bad: number;
  avgScore: number;
  byKind: Partial<Record<ReplyKind, { judged: number; avgScore: number; bad: number }>>;
}

export interface QualityReport {
  judge: string;
  dailyCap: number;
  judgedToday: number;
  /** Oldest first, up to 14 days. */
  days: DayScore[];
  /** Last 7 days, newest first. */
  recent: JudgedReply[];
  /** Last 7 days. */
  issues: { category: IssueCategory; count: number }[];
  /** Last 7 days: what would fix the weak and bad replies, grouped. */
  fixes: { type: FixType; count: number; examples: { runId: string; ticketId: string; fix: string }[] }[];
}

export type ActionRule =
  | "duplicate_dev_item"
  | "repeated_dev_post"
  | "closed_while_escalated"
  | "thin_dev_item"
  | "dev_write_failed"
  | "cancelled_subscription";

/** One time an action rule caught something Jetta did (lib/self-review/actions.ts). */
export interface ActionFinding {
  /** Stable id, used to post each finding to Slack once. */
  key: string;
  rule: ActionRule;
  severity: "bad" | "warn";
  ticketId: string;
  /** Unix ms of the latest run involved. */
  at: number;
  title: string;
  detail: string;
  runIds: string[];
}

export interface ActionReport {
  days: number;
  counts: {
    devItemsFiled: number;
    devQuestions: number;
    dedupedOntoExisting: number;
    devPosts: number;
    escalations: number;
    compliance: number;
    closes: number;
    billing: number;
  };
  findings: ActionFinding[];
}

export interface SelfReviewSummary {
  computedAt: number;
  reliability: ReliabilityReport | null;
  quality: QualityReport;
  /** Absent on summaries written before the action rules existed. */
  actions?: ActionReport;
  /** What the latest run posted to Slack. */
  alerts: { at: number; text: string }[];
  settings: { enabled: boolean; alerts: boolean; judge: string; dailyCap: number; channel: string };
}
