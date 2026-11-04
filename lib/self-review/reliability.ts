/**
 * Self-review, part 1: is Jetta herself working? No model involved.
 *
 * Three readings, each compared with Jetta's own recent normal rather than a
 * fixed number, because what is normal differs a lot between them:
 *   - crons: each scheduled job's heartbeat (lib/cron-beat.ts) against its
 *     schedule in vercel.json, so a job that silently stopped shows as late,
 *     and one that keeps erroring shows as failing;
 *   - runs: the agent run logs (every ticket, chat and dev-bridge run), last
 *     24h against the days before: errors, runs that ended without a reply,
 *     and how slow they were (the Vercel limit is 300s);
 *   - events: error-level ops events by name, so a new kind of failure, or one
 *     suddenly far more frequent, is named the day it starts.
 * Pure over its inputs (`assessReliability`), so it is testable offline.
 */
import vercelJson from "@/vercel.json";
import type { CronBeat } from "../cron-beat";
import type { RunLog } from "../kv";
import type { OpsEvent } from "../events";
import type { CronHealth, EventCount, ReliabilityReport, RunHealth, SelfReviewFlag } from "./types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Minutes between runs for the simple schedules vercel.json uses. */
export function everyMinutes(schedule: string): number {
  const [min, hour] = schedule.trim().split(/\s+/);
  if (min === "*") return 1;
  const stepMin = /^\*\/(\d+)$/.exec(min);
  if (stepMin) return Number(stepMin[1]);
  if (hour === "*") return 60;
  const stepHour = /^\*\/(\d+)$/.exec(hour);
  if (stepHour) return 60 * Number(stepHour[1]);
  return 1440;
}

export function cronSchedules(): { name: string; path: string; schedule: string }[] {
  return (vercelJson.crons ?? []).map((c) => ({ name: c.path.split("/").pop() ?? c.path, path: c.path, schedule: c.schedule }));
}

export function assessCrons(beats: Record<string, CronBeat>, now: number): CronHealth[] {
  return cronSchedules().map(({ name, path, schedule }) => {
    const b = beats[name];
    const every = everyMinutes(schedule);
    // Half an interval of slack plus ten minutes: Vercel crons can start late,
    // and a daily job that ran at 09:20 instead of 09:00 is not "late".
    const lateAfter = every * 60_000 * 1.5 + 10 * 60_000;
    let state: CronHealth["state"] = "unknown";
    if (b) {
      if (b.failStreak >= (every >= 1440 ? 1 : 2)) state = "failing";
      else if (now - b.at > lateAfter) state = "late";
      else state = "ok";
    }
    return {
      name,
      path,
      schedule,
      everyMin: every,
      state,
      lastAt: b?.at,
      okAt: b?.okAt,
      status: b?.status,
      ms: b?.ms,
      failStreak: b?.failStreak ?? 0,
      lastError: b?.lastError,
    };
  });
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

/** A run that should have produced a reply and did not. Dev-bridge runs often rightly do nothing. */
function missedReply(l: RunLog): boolean {
  return (l.source === "jettachat" || l.source === "webhook") && !l.replied && !l.escalated && !l.error;
}

export function assessRuns(logs: RunLog[], now: number): RunHealth {
  const last = logs.filter((l) => now - l.at * 1000 < DAY);
  const before = logs.filter((l) => now - l.at * 1000 >= DAY && now - l.at * 1000 < 8 * DAY);
  const spanDays = before.length ? Math.max(1, (now - DAY - Math.min(...before.map((l) => l.at * 1000))) / DAY) : 0;
  const rate = (xs: RunLog[], f: (l: RunLog) => boolean) => (xs.length ? xs.filter(f).length / xs.length : 0);
  const sources = [...new Set(last.map((l) => l.source))];
  return {
    runs: last.length,
    errors: last.filter((l) => l.error).length,
    missedReplies: last.filter(missedReply).length,
    escalated: last.filter((l) => l.escalated).length,
    p50Ms: pct(last.map((l) => l.durationMs), 50),
    p95Ms: pct(last.map((l) => l.durationMs), 95),
    slow: last.filter((l) => l.durationMs > 240_000).length,
    bySource: sources.map((s) => {
      const xs = last.filter((l) => l.source === s);
      return { source: s, runs: xs.length, errors: xs.filter((l) => l.error).length, p95Ms: pct(xs.map((l) => l.durationMs), 95) };
    }),
    baseline: {
      days: Math.round(spanDays * 10) / 10,
      runsPerDay: spanDays ? Math.round(before.length / spanDays) : 0,
      errorRate: rate(before, (l) => !!l.error),
      missedRate: rate(before, missedReply),
      p95Ms: pct(before.map((l) => l.durationMs), 95),
    },
    recentErrors: last
      .filter((l) => l.error)
      .slice(0, 8)
      .map((l) => ({ at: l.at * 1000, source: l.source, ticketId: l.ticketId, error: (l.error ?? "").slice(0, 240) })),
  };
}

export function assessEvents(events: OpsEvent[], now: number): { errors24h: number; warns24h: number; spanHours: number; top: EventCount[] } {
  const oldest = events.length ? Math.min(...events.map((e) => e.at)) : now;
  const spanHours = Math.round((now - oldest) / HOUR);
  const priorDays = Math.max(0, (now - DAY - oldest) / DAY);
  const byName = new Map<string, { last: number; before: number; level: OpsEvent["level"] }>();
  for (const e of events) {
    if (e.level === "info") continue;
    const c = byName.get(e.event) ?? { last: 0, before: 0, level: e.level };
    if (now - e.at < DAY) c.last++;
    else c.before++;
    if (e.level === "error") c.level = "error";
    byName.set(e.event, c);
  }
  const top: EventCount[] = [...byName.entries()]
    .filter(([, c]) => c.last > 0)
    .map(([event, c]) => ({
      event,
      level: c.level,
      count24h: c.last,
      perDayBefore: priorDays >= 0.5 ? Math.round((c.before / priorDays) * 10) / 10 : null,
      isNew: priorDays >= 1 && c.before === 0,
    }))
    .sort((a, b) => (a.level === b.level ? b.count24h - a.count24h : a.level === "error" ? -1 : 1))
    .slice(0, 15);
  return {
    errors24h: events.filter((e) => e.level === "error" && now - e.at < DAY).length,
    warns24h: events.filter((e) => e.level === "warn" && now - e.at < DAY).length,
    spanHours,
    top,
  };
}

const secs = (ms: number) => `${Math.round(ms / 1000)}s`;

export function reliabilityFlags(r: Omit<ReliabilityReport, "flags">): SelfReviewFlag[] {
  const flags: SelfReviewFlag[] = [];
  for (const c of r.crons) {
    if (c.state === "failing") {
      flags.push({
        key: `cron-failing:${c.name}`,
        severity: "bad",
        title: `The ${c.name} cron is failing`,
        detail: `${c.failStreak} run${c.failStreak === 1 ? "" : "s"} in a row ended in error${c.lastError ? `: ${c.lastError}` : ""}.`,
      });
    } else if (c.state === "late") {
      flags.push({
        key: `cron-late:${c.name}`,
        severity: "bad",
        title: `The ${c.name} cron has stopped running`,
        detail: `Scheduled every ${c.everyMin >= 1440 ? "day" : c.everyMin >= 60 ? `${c.everyMin / 60}h` : `${c.everyMin} min`}; it last ran ${Math.round((r.computedAt - (c.lastAt ?? 0)) / 60_000)} min ago.`,
      });
    }
  }
  const { runs: x } = r;
  const errRate = x.runs ? x.errors / x.runs : 0;
  if (x.errors >= 3 && errRate > Math.max(0.05, 2 * x.baseline.errorRate)) {
    flags.push({
      key: "runs-errors",
      severity: "bad",
      title: `${x.errors} of ${x.runs} runs failed in the last 24h`,
      detail: `Usually ${Math.round(x.baseline.errorRate * 100)}% of runs fail. Latest: ${x.recentErrors[0]?.error ?? "?"}`,
    });
  }
  const missRate = x.runs ? x.missedReplies / x.runs : 0;
  if (x.missedReplies >= 3 && missRate > Math.max(0.1, 2 * x.baseline.missedRate)) {
    flags.push({
      key: "runs-missed",
      severity: "warn",
      title: `${x.missedReplies} runs ended without a reply or a hand-off`,
      detail: `A chat or ticket run that neither replied nor escalated leaves the customer waiting. Usually ${Math.round(x.baseline.missedRate * 100)}% of runs.`,
    });
  }
  if (x.runs >= 5 && x.p95Ms > 120_000 && x.baseline.p95Ms && x.p95Ms > 1.5 * x.baseline.p95Ms) {
    flags.push({
      key: "runs-slow",
      severity: "warn",
      title: `Runs are slower: p95 ${secs(x.p95Ms)} against a usual ${secs(x.baseline.p95Ms)}`,
      detail: `${x.slow} run${x.slow === 1 ? "" : "s"} took over 4 minutes; Vercel stops a run at 5.`,
    });
  }
  if (x.baseline.runsPerDay >= 10 && x.runs < x.baseline.runsPerDay * 0.25) {
    flags.push({
      key: "runs-quiet",
      severity: "warn",
      title: `Only ${x.runs} runs in the last 24h, against about ${x.baseline.runsPerDay} a day`,
      detail: "Fewer tickets is possible, but so is a webhook or the chat widget that stopped reaching Jetta.",
    });
  }
  for (const e of r.events.top.filter((e) => e.level === "error")) {
    if (e.isNew && e.count24h >= 3) {
      flags.push({ key: `event-new:${e.event}`, severity: "warn", title: `New error: ${e.event}`, detail: `${e.count24h} times in the last 24h, never in the days before.` });
    } else if (e.perDayBefore != null && e.count24h >= 10 && e.count24h > 3 * Math.max(1, e.perDayBefore)) {
      flags.push({ key: `event-spike:${e.event}`, severity: "warn", title: `Error spike: ${e.event}`, detail: `${e.count24h} in the last 24h against about ${e.perDayBefore} a day.` });
    }
  }
  return flags;
}

export function assessReliability(input: { beats: Record<string, CronBeat>; logs: RunLog[]; events: OpsEvent[]; now: number }): ReliabilityReport {
  const base = {
    computedAt: input.now,
    crons: assessCrons(input.beats, input.now),
    runs: assessRuns(input.logs, input.now),
    events: assessEvents(input.events, input.now),
  };
  return { ...base, flags: reliabilityFlags(base) };
}
