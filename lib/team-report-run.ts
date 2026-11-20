/**
 * Builds the daily team report from the stores and posts it. The pure half is
 * lib/team-report.ts; this is the reads, the once-a-day guard and the post.
 *
 * Armed by a channel alone (JETTA_TEAM_REPORT_CHANNEL): with none set the cron
 * builds nothing and posts nothing. The preview (dry) builds the same text for
 * any day without posting, with or without a channel.
 */
import { config } from "./config";
import { parseAliases } from "./activity";
import { getSlackNames, loadActivities } from "./activity-store";
import { getDevBoardRows } from "./dev-board-sync";
import { getOpsEvents } from "./events";
import { itemTickets } from "./dev-item-links";
import { markEventSeen, unmarkEventSeen } from "./kv";
import { getSupportHealth, loadPerfTickets } from "./performance-sync";
import { buildTeamReport, formatTeamReport, isEmptyReport, teamReportMessages, type ReportMessage, type TeamReport } from "./team-report";
import { freshdeskTicketUrl } from "./tools/freshdesk";
import { postTeamReport } from "./tools/slack";
import { shiftDayKey, supportTimeZone, zonedDayKey } from "./tz";

const DAY_MS = 86_400_000;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** The report's own zone when it is a real IANA name, else the support timezone. */
export function reportTimeZone(): string {
  const name = config.teamReport.timezone;
  if (!name) return supportTimeZone();
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: name });
    return name;
  } catch {
    console.warn(`JETTA_TEAM_REPORT_TZ="${name}" is not a valid IANA timezone; using the support timezone.`);
    return supportTimeZone();
  }
}

/** Yesterday in the report's timezone: the day the morning post is about. */
export function reportDay(now = Date.now(), tz = reportTimeZone()): string {
  return shiftDayKey(zonedDayKey(new Date(now), tz), -1);
}

export async function previewTeamReport(
  day?: string,
  now = Date.now(),
): Promise<{ report: TeamReport; text: string; tables: ReportMessage[] | null }> {
  const tz = reportTimeZone();
  const d = day && DAY_KEY.test(day) ? day : reportDay(now, tz);
  // Two days of slack either side of the day covers every timezone offset.
  const since = Date.parse(`${d}T00:00:00Z`) - 2 * DAY_MS;
  const [acts, slackNames, tickets, health, devRows, links, events] = await Promise.all([
    loadActivities(since),
    getSlackNames().catch(() => ({})),
    loadPerfTickets(),
    getSupportHealth().catch(() => null),
    // Each of these is optional: without it the report loses a section, not the post.
    getDevBoardRows().catch(() => null),
    itemTickets().catch(() => null),
    // Jetta's own sends. The event log keeps the newest 5,000 events (a few
    // days), which covers yesterday; a preview of an older day shows none.
    getOpsEvents({ sinceMs: since, limit: 5000 }).catch(() => []),
  ]);
  const SENT: Record<string, "first" | "followup"> = { "first_response.sent": "first", "ticket_followup.sent": "followup" };
  const jettaSent = events
    .filter((e) => e.event in SENT && e.ticketId)
    .map((e) => ({ at: e.at, ticketId: Number(e.ticketId), kind: SENT[e.event] }));
  const report = buildTeamReport({
    day: d,
    tz,
    acts,
    tickets,
    aliases: parseAliases(config.agentAliases),
    slackNames,
    now,
    backlog: health?.backlog ?? null,
    devRows,
    itemTickets: links,
    jettaSent,
  });
  const urls = { ticketUrlBase: freshdeskTicketUrl(""), consoleUrl: config.consoleUrl };
  // `text` is the whole report as plain lines: the fallback when tables are refused, and the preview.
  return { report, text: formatTeamReport(report, urls), tables: teamReportMessages(report, urls) };
}

export type TeamReportResult =
  | { status: "off"; reason: string }
  | { status: "already_posted" | "empty"; day: string; people: number }
  | { status: "posted"; day: string; people: number; as: "tables" | "text" }
  | { status: "error"; day: string; error: string };

export async function runTeamReport(now = Date.now()): Promise<TeamReportResult> {
  const channel = config.teamReport.channel;
  if (!channel) return { status: "off", reason: "JETTA_TEAM_REPORT_CHANNEL is not set" };
  const day = reportDay(now);
  const { report, text, tables } = await previewTeamReport(day, now);
  const people = report.people.length;
  if (isEmptyReport(report)) return { status: "empty", day, people };
  // One post per day, however often the cron or a retry fires.
  const marker = `team-report:${day}`;
  if (!(await markEventSeen(marker, 3 * 86_400))) return { status: "already_posted", day, people };
  try {
    const as = await postTeamReport(channel, text, tables);
    return { status: "posted", day, people, as };
  } catch (e) {
    await unmarkEventSeen(marker).catch(() => {});
    return { status: "error", day, error: e instanceof Error ? e.message : String(e) };
  }
}
