/**
 * Jetta's self-review: an hourly look at her own work, behind /self-review.
 *
 * Each run of the cron (app/api/cron/self-review):
 *   1. Reliability (lib/self-review/reliability.ts, no model): late or failing
 *      crons, run errors, runs that ended with no reply, latency, new or
 *      spiking error events, each against her own recent normal.
 *   2. Quality (lib/self-review/quality.ts): judges up to PER_RUN of her recent
 *      customer-facing replies that have not been judged yet, chat first since
 *      no person reads those before the customer does. At most
 *      JETTA_SELF_REVIEW_DAILY a day, so the cost is bounded (about $1/day on
 *      Kimi K3.1 Pro at 40 replies).
 *   3. Slack (ops channel, JETTA_SELF_REVIEW_ALERTS): each new reliability flag
 *      once per 12h, each chat answer judged bad, and one scorecard a day for
 *      the day before.
 * The page reads one key (the summary). Nothing here reaches a customer or
 * changes what Jetta does: findings are for a person to act on.
 */
import { Redis } from "@upstash/redis";
import { config } from "../config";
import { getCronBeats } from "../cron-beat";
import { getOpsEvents, logOpsEvent } from "../events";
import { getRunLogs, markEventSeen, unmarkEventSeen, type RunLog } from "../kv";
import { getConversation } from "../chat-store";
import { mirrorConversations } from "../ticket-mirror/read";
import { bumpDataVersion } from "../data-version";
import { shiftDayKey, supportTimeZone, zonedDayKey } from "../tz";
import * as slack from "../tools/slack";
import { assessReliability } from "./reliability";
import { assessActions } from "./actions";
import { evidenceFromTrace, finalVerdict, judgeModelId, judgeReply, judgeable, kindOf, replyOf, ruleChecks } from "./quality";
import { FIX_TYPES, ISSUE_CATEGORIES, type DayScore, type JudgedReply, type QualityReport, type SelfReviewSummary } from "./types";

export * from "./types";

const SUMMARY_KEY = "jetta:selfreview:summary:v1";
const JUDGED_KEY = "jetta:selfreview:judged:v1";
const JUDGED_CAP = 800;
const LOCK_ID = "selfreview-lock";
/** Replies judged per hourly run. Spreads the day's budget instead of one burst. */
const PER_RUN = 6;
/** Stop starting new judgements after this, so the run ends inside Vercel's 300s. */
const JUDGE_BUDGET_MS = 170_000;

let redis: Redis | null = null;
function client(): Redis | null {
  if (config.kv.url && config.kv.token) {
    redis ??= new Redis({ url: config.kv.url, token: config.kv.token });
    return redis;
  }
  return null;
}
const mem = new Map<string, unknown>();
const memJudged: JudgedReply[] = [];

async function getJson<T>(key: string): Promise<T | null> {
  const r = client();
  return r ? ((await r.get<T>(key)) ?? null) : ((mem.get(key) as T) ?? null);
}
async function setJson(key: string, value: unknown): Promise<void> {
  const r = client();
  if (r) await r.set(key, JSON.stringify(value));
  else mem.set(key, value);
}

export const getSelfReviewSummary = () => getJson<SelfReviewSummary>(SUMMARY_KEY);
/** Only for scripts/self-review-preview.mts, which seeds a dev store. */
export const storeSelfReviewSummary = (s: SelfReviewSummary) => setJson(SUMMARY_KEY, s);

async function getJudged(): Promise<JudgedReply[]> {
  const r = client();
  if (!r) return [...memJudged];
  // ~3 kB a row; 800 rows stays far under Upstash's 10 MB response cap.
  const raw = await r.lrange<JudgedReply | string>(JUDGED_KEY, 0, JUDGED_CAP - 1);
  return raw.map((x) => (typeof x === "string" ? (JSON.parse(x) as JudgedReply) : x));
}

async function saveJudged(rows: JudgedReply[]): Promise<void> {
  if (!rows.length) return;
  const r = client();
  if (r) {
    await r.lpush(JUDGED_KEY, ...rows.map((x) => JSON.stringify(x)));
    await r.ltrim(JUDGED_KEY, 0, JUDGED_CAP - 1);
    return;
  }
  memJudged.unshift(...rows);
  memJudged.length = Math.min(memJudged.length, JUDGED_CAP);
}

// ── context for the judge ───────────────────────────────────────────

/** Marks a context the judge must not grade "not answered" against. */
export const INCOMPLETE = "[CONTEXT INCOMPLETE: only the subject could be read, not the thread.]";

/** The conversation up to the run, oldest first, as plain text. */
async function conversationBefore(l: RunLog): Promise<string> {
  const cutoff = l.at * 1000 + 1500;
  if (l.channel === "jettachat") {
    const conv = await getConversation(l.ticketId).catch(() => null);
    if (!conv) return `${INCOMPLETE}\nSubject: ${l.subject ?? ""}`;
    return conv.messages
      .filter((m) => !m.system && Date.parse(m.createdAt) <= cutoff)
      .slice(-10)
      .map((m) => `${m.author === "visitor" ? "Customer" : m.via === "human" ? "Human agent" : "Jetta"}: ${m.text}`)
      .join("\n\n")
      .slice(-6000);
  }
  const thread = /^\d+$/.test(l.ticketId) ? await mirrorConversations(Number(l.ticketId)).catch(() => null) : null;
  if (thread) {
    const parts = [`Subject: ${l.subject ?? ""}`, `Customer: ${thread.description ?? ""}`];
    for (const c of thread.conversations) {
      if (c.private || Date.parse(c.created_at) > cutoff) continue;
      parts.push(`${c.incoming ? "Customer" : "Agent"}: ${c.body_text ?? ""}`);
    }
    return parts.join("\n\n").slice(-6000);
  }
  // The mirror is behind or off: the ticket as the run itself read it.
  const t = l.trace.find((x) => x.tool === "get_ticket_details");
  return t ? String(t.result).slice(0, 6000) : `${INCOMPLETE}\nSubject: ${l.subject ?? ""}`;
}

/** Judge one run. `loadContext` is swappable so the preview script can read production over the admin API. */
export async function judgeRun(l: RunLog, loadContext: (l: RunLog) => Promise<string> = conversationBefore): Promise<JudgedReply> {
  const kind = kindOf(l);
  const reply = replyOf(l)!;
  const customerAsk = await loadContext(l);
  const evidence = evidenceFromTrace({ trace: l.trace as never }, 9000);
  const checks = await ruleChecks(kind, reply, evidence, customerAsk);
  const judge = judgeModelId();
  const j = await judgeReply({ kind, app: l.app, subject: l.subject, customerAsk, evidence, reply, escalated: l.escalated }, judge);
  return {
    runId: l.id,
    at: l.at * 1000,
    judgedAt: Date.now(),
    day: zonedDayKey(new Date(l.at * 1000)),
    kind,
    source: l.source,
    ticketId: l.ticketId,
    subject: l.subject,
    app: l.app,
    product: l.product,
    writer: l.model,
    judge,
    customerAsk: customerAsk.slice(-1500),
    reply: reply.slice(0, 2500),
    escalated: l.escalated,
    checks,
    answered: j.answered,
    grounded: j.grounded,
    summary: j.summary,
    ...finalVerdict(j, checks),
  };
}

/** Which runs to judge now: unjudged, recent, chat first, at most two per conversation a day. */
export function pickRuns(logs: RunLog[], judged: JudgedReply[], now: number, limit: number): RunLog[] {
  const done = new Set(judged.map((j) => j.runId));
  const perTicketToday = new Map<string, number>();
  const today = zonedDayKey(new Date(now));
  for (const j of judged) if (j.day === today) perTicketToday.set(j.ticketId, (perTicketToday.get(j.ticketId) ?? 0) + 1);
  const fresh = logs.filter((l) => now - l.at * 1000 < 36 * 3_600_000 && !done.has(l.id) && judgeable(l));
  const order = { chat: 0, email: 1, dev_bridge: 2 } as const;
  fresh.sort((a, b) => order[kindOf(a)] - order[kindOf(b)] || b.at - a.at);
  const out: RunLog[] = [];
  for (const l of fresh) {
    if (out.length >= limit) break;
    const n = perTicketToday.get(l.ticketId) ?? 0;
    if (n >= 2) continue;
    perTicketToday.set(l.ticketId, n + 1);
    out.push(l);
  }
  return out;
}

// ── rollups ─────────────────────────────────────────────────────────

/** Replies judged ON a day (by when the judge ran, not when the run was): the daily cap counts these. */
export function judgedOn(judged: JudgedReply[], day: string): number {
  return judged.filter((j) => zonedDayKey(new Date(j.judgedAt ?? j.at)) === day).length;
}

const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : 0);

export function buildQuality(judged: JudgedReply[], now: number): QualityReport {
  const today = zonedDayKey(new Date(now));
  const days: DayScore[] = [];
  for (let i = 13; i >= 0; i--) {
    const day = shiftDayKey(today, -i);
    const xs = judged.filter((j) => j.day === day);
    const byKind: DayScore["byKind"] = {};
    for (const k of ["chat", "email", "dev_bridge"] as const) {
      const ks = xs.filter((j) => j.kind === k);
      if (ks.length) byKind[k] = { judged: ks.length, avgScore: avg(ks.map((j) => j.score)), bad: ks.filter((j) => j.verdict === "bad").length };
    }
    days.push({
      day,
      judged: xs.length,
      good: xs.filter((j) => j.verdict === "good").length,
      weak: xs.filter((j) => j.verdict === "weak").length,
      bad: xs.filter((j) => j.verdict === "bad").length,
      avgScore: avg(xs.map((j) => j.score)),
      byKind,
    });
  }
  const weekStart = shiftDayKey(today, -6);
  const week = judged.filter((j) => j.day >= weekStart).sort((a, b) => b.at - a.at);
  const issues = ISSUE_CATEGORIES.map((category) => ({ category, count: week.filter((j) => j.issues.some((i) => i.category === category)).length }))
    .filter((x) => x.count)
    .sort((a, b) => b.count - a.count);
  const fixes = FIX_TYPES.filter((t) => t !== "none")
    .map((type) => {
      const xs = week.filter((j) => j.verdict !== "good" && j.fixType === type && j.fix);
      return { type, count: xs.length, examples: xs.slice(0, 6).map((j) => ({ runId: j.runId, ticketId: j.ticketId, fix: j.fix })) };
    })
    .filter((x) => x.count)
    .sort((a, b) => b.count - a.count);
  return {
    judge: judgeModelId(),
    dailyCap: config.selfReview.dailyCap,
    judgedToday: judgedOn(judged, today),
    days,
    recent: week.slice(0, 150),
    issues,
    fixes,
  };
}

function localHour(now: number): number {
  return Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: supportTimeZone() }).format(new Date(now)));
}

function scorecardText(d: DayScore, q: QualityReport): { headline: string; details: string[] } {
  const kinds = Object.entries(d.byKind)
    .map(([k, v]) => `${k.replace("_", " ")} ${v!.avgScore}/5 (${v!.judged}${v!.bad ? `, ${v!.bad} bad` : ""})`)
    .join(" · ");
  return {
    headline: `:clipboard: Jetta's self-review for ${d.day}: ${d.judged} replies judged, average ${d.avgScore}/5, ${d.good} good · ${d.weak} weak · ${d.bad} bad.`,
    details: [
      kinds ? `By channel: ${kinds}` : "",
      q.issues.length ? `Most common problems this week: ${q.issues.slice(0, 4).map((i) => `${i.category.replace(/_/g, " ")} (${i.count})`).join(", ")}` : "",
      ...q.fixes.slice(0, 2).flatMap((f) => [`*${f.type.replace(/_/g, " ")}* (${f.count}): ${f.examples[0]?.fix ?? ""}`]),
      "Details on the console's Self-review page.",
    ].filter(Boolean),
  };
}

// ── the run ─────────────────────────────────────────────────────────

export interface SelfReviewRunResult {
  status: "ok" | "off" | "busy" | "error";
  judged?: number;
  judgeFailures?: number;
  flags?: number;
  actionFindings?: number;
  alerts?: number;
  ms?: number;
  error?: string;
}

export async function runSelfReview(opts: { notify?: boolean; judge?: boolean } = {}): Promise<SelfReviewRunResult> {
  if (!config.selfReview.enabled) return { status: "off" };
  if (!(await markEventSeen(LOCK_ID, 290))) return { status: "busy" };
  const started = Date.now();
  try {
    const now = Date.now();
    const [beats, logs, events, judgedBefore, prev] = await Promise.all([
      getCronBeats(),
      getRunLogs(500),
      getOpsEvents({ limit: 5000 }),
      getJudged(),
      getSelfReviewSummary(),
    ]);
    const reliability = assessReliability({ beats, logs, events, now });
    const actions = assessActions(logs, now);

    // Quality: a few unjudged replies, inside the day's budget.
    const fresh: JudgedReply[] = [];
    let judgeFailures = 0;
    if (opts.judge !== false && config.openrouter.apiKey) {
      const today = zonedDayKey(new Date(now));
      const left = Math.max(0, config.selfReview.dailyCap - judgedOn(judgedBefore, today));
      const queue = pickRuns(logs, judgedBefore, now, Math.min(PER_RUN, left));
      const worker = async () => {
        while (queue.length && Date.now() - started < JUDGE_BUDGET_MS) {
          const l = queue.shift()!;
          try {
            fresh.push(await judgeRun(l));
          } catch (e) {
            judgeFailures++;
            await logOpsEvent({ level: "warn", event: "selfreview.judge_failed", source: "cron", ticketId: l.ticketId, data: { runId: l.id, message: e instanceof Error ? e.message.slice(0, 300) : String(e) } });
          }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      await saveJudged(fresh);
    }
    const judged = [...fresh, ...judgedBefore];
    const quality = buildQuality(judged, now);

    // Slack.
    const alerts: { at: number; text: string }[] = [];
    const post = async (headline: string, details: string[]) => {
      if (config.selfReview.alerts) await slack.notifySelfReview(headline, details).catch(() => undefined);
      alerts.push({ at: Date.now(), text: headline });
    };
    if (opts.notify !== false) {
      const fresh12h = [];
      for (const f of reliability.flags) if (await markEventSeen(`selfreview:flag:${f.key}`, 12 * 3600)) fresh12h.push(f);
      if (fresh12h.length) {
        await post(
          `:stethoscope: Jetta self-check: ${fresh12h.length === 1 ? fresh12h[0].title : `${fresh12h.length} things need a look`}`,
          fresh12h.map((f) => `• ${f.severity === "bad" ? ":red_circle:" : ":large_yellow_circle:"} *${f.title}*: ${f.detail}`),
        );
      }
      // Action findings from the last day, each once. Older ones were either
      // posted already or predate this check; the page still lists them.
      const newActions = [];
      for (const f of actions.findings.filter((x) => now - x.at < 86_400_000)) {
        if (await markEventSeen(`selfreview:action:${f.key}`, 14 * 86_400)) newActions.push(f);
      }
      if (newActions.length) {
        await post(
          `:hammer_and_wrench: Jetta's actions: ${newActions.length === 1 ? newActions[0].title : `${newActions.length} things to check`}`,
          [
            ...newActions.slice(0, 8).map((f) => `• ${f.severity === "bad" ? ":red_circle:" : ":large_yellow_circle:"} *${f.title}*: ${f.detail}`),
            "Details on the console's Self-review page.",
          ],
        );
      }
      for (const j of fresh.filter((x) => x.kind === "chat" && x.verdict === "bad")) {
        if (!(await markEventSeen(`selfreview:bad:${j.runId}`, 7 * 86_400))) continue;
        await post(`:warning: A chat answer Jetta sent was judged bad (${j.score}/5)${j.app ? ` · ${j.app}` : ""}: ${j.summary}`, [
          `*Customer:* ${j.customerAsk.split("\n\n").filter((p) => p.startsWith("Customer:")).pop()?.slice(9, 400) ?? ""}`,
          `*Jetta:* ${j.reply.slice(0, 600)}`,
          ...j.issues.slice(0, 3).map((i) => `• ${i.category.replace(/_/g, " ")}: ${i.detail}`),
          j.fix ? `*Fix:* ${j.fix}` : "",
          `Conversation ${j.ticketId} on the console's Chats page.`,
        ].filter(Boolean));
      }
      // Yesterday's scorecard, once, from 09:00 support time.
      const yesterday = quality.days[quality.days.length - 2];
      if (yesterday?.judged && localHour(now) >= 9 && (await markEventSeen(`selfreview:digest:${yesterday.day}`, 3 * 86_400))) {
        const { headline, details } = scorecardText(yesterday, quality);
        await post(headline, details);
      }
    }

    const summary: SelfReviewSummary = {
      computedAt: now,
      reliability,
      quality,
      actions,
      alerts: [...alerts, ...(prev?.alerts ?? [])].slice(0, 30),
      settings: {
        enabled: config.selfReview.enabled,
        alerts: config.selfReview.alerts,
        judge: judgeModelId(),
        dailyCap: config.selfReview.dailyCap,
        channel: slack.selfReviewChannel(),
      },
    };
    await setJson(SUMMARY_KEY, summary);
    await bumpDataVersion("selfreview");
    return { status: "ok", judged: fresh.length, judgeFailures, flags: reliability.flags.length, actionFindings: actions.findings.length, alerts: alerts.length, ms: Date.now() - started };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e), ms: Date.now() - started };
  } finally {
    await unmarkEventSeen(LOCK_ID).catch(() => {});
  }
}
