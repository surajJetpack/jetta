"use client";

/**
 * The metric rows on /health — the headline five, the secondary five, and who
 * carried the load. Each number opens the tickets behind it.
 */
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MetricRow, type MetricSpec } from "@/components/jetta/metric-row";
import { fmtHours } from "@/lib/format";
import { TARGETS, toneAbove, toneBelow, type Backlog, type HealthPeriod, type SupportHealth } from "@/lib/support-health";
import { pct, type Open } from "./health-shared";

const PRIOR = "vs prior 28 days";
function countDelta(now: number, before: number): string {
  const d = now - before;
  return `${d > 0 ? "+" : d < 0 ? "−" : "±"}${Math.abs(d)} ${PRIOR}`;
}
function pctDelta(now: number | null, before: number | null): string | undefined {
  if (now == null || before == null) return undefined;
  const d = Math.round((now - before) * 100);
  return `${d > 0 ? "+" : d < 0 ? "−" : "±"}${Math.abs(d)} pts ${PRIOR}`;
}
function hrsDelta(now: number | null, before: number | null): string | undefined {
  if (now == null || before == null) return undefined;
  const d = now - before;
  return `${d > 0 ? "+" : d < 0 ? "−" : "±"}${fmtHours(Math.abs(d))} ${PRIOR}`;
}

export function Headline({ recent, previous, backlog, open }: { recent: HealthPeriod; previous: HealthPeriod; backlog: Backlog; open: Open }) {
  const metrics: MetricSpec[] = [
    {
      label: "Tickets",
      value: recent.tickets,
      hint: countDelta(recent.tickets, previous.tickets),
      onClick: () =>
        open({
          title: "Tickets, last 28 days",
          description: "Every ticket that arrived in the last 28 days and that a person answered or is still open.",
          drill: { kind: "tickets" },
        }),
    },
    {
      label: `Answered within ${TARGETS.firstReplyH}h`,
      value: pct(recent.withinTarget),
      tone: toneAbove(recent.withinTarget, TARGETS.firstReplyShare) ?? undefined,
      hint: pctDelta(recent.withinTarget, previous.withinTarget),
      onClick: () =>
        open({
          title: `Answered within ${TARGETS.firstReplyH}h`,
          description: `Tickets from the last 28 days, misses first. A ticket still unanswered after ${TARGETS.firstReplyH}h counts as a miss; one younger than that isn't counted yet.`,
          drill: { kind: "within", hours: TARGETS.firstReplyH },
        }),
    },
    {
      label: "Median first reply",
      value: fmtHours(recent.firstReplyH),
      tone: toneBelow(recent.firstReplyH, TARGETS.medianFirstReplyH) ?? undefined,
      hint: `slowest 10%: over ${fmtHours(recent.firstReplyP90H)}`,
      onClick: () =>
        open({
          title: "First reply times",
          description: "Answered tickets from the last 28 days, slowest first. The median is the middle of this list.",
          drill: { kind: "firstReply" },
        }),
    },
    {
      label: "Reopened",
      value: pct(recent.reopenRate),
      tone: toneBelow(recent.reopenRate, TARGETS.reopenRate) ?? undefined,
      hint: pctDelta(recent.reopenRate, previous.reopenRate),
      onClick: () =>
        open({
          title: "Reopened tickets",
          description: "Answered tickets from the last 28 days the customer came back on after they were resolved.",
          drill: { kind: "reopened" },
        }),
    },
    {
      label: "Waiting on us now",
      value: backlog.owesReply,
      tone: toneBelow(backlog.overdue, TARGETS.overdueNow) ?? undefined,
      hint: backlog.overdue
        ? `${backlog.overdue} over ${TARGETS.firstReplyH}h · longest ${fmtHours(backlog.oldestOwedH)}`
        : backlog.owesReply
          ? `none over ${TARGETS.firstReplyH}h`
          : "nobody waiting",
      onClick: () =>
        open({
          title: "Customers waiting on us",
          description: "Open tickets where the customer wrote the newest message, longest wait first.",
          drill: { kind: "bucket", bucket: "owes_reply" },
        }),
    },
  ];
  return <MetricRow metrics={metrics} />;
}

export function Secondary({
  recent,
  previous,
  chat,
  open,
}: {
  recent: HealthPeriod;
  previous: HealthPeriod;
  chat: SupportHealth["chat"];
  open: Open;
}) {
  const metrics: MetricSpec[] = [
    {
      label: `Answered within ${TARGETS.fastReplyH}h`,
      value: pct(recent.withinFast),
      hint: pctDelta(recent.withinFast, previous.withinFast),
      onClick: () =>
        open({
          title: `Answered within ${TARGETS.fastReplyH}h`,
          description: `Tickets from the last 28 days, misses first. A ticket still unanswered after ${TARGETS.fastReplyH}h counts as a miss.`,
          drill: { kind: "within", hours: TARGETS.fastReplyH },
        }),
    },
    {
      label: "Median time to resolve",
      value: fmtHours(recent.resolvedH),
      hint: hrsDelta(recent.resolvedH, previous.resolvedH),
      onClick: () =>
        open({
          title: "Time to resolve",
          description: "Answered tickets from the last 28 days that have been resolved, longest first.",
          drill: { kind: "resolved" },
        }),
    },
    {
      label: "Customer messages per ticket",
      value: recent.customerMsgsPerTicket?.toFixed(1) ?? "—",
      hint:
        previous.customerMsgsPerTicket != null
          ? `${previous.customerMsgsPerTicket.toFixed(1)} in the prior 28 days`
          : undefined,
      onClick: () =>
        open({
          title: "Back-and-forth",
          description: "Answered tickets from the last 28 days, most customer messages first.",
          drill: { kind: "backAndForth" },
        }),
    },
    {
      label: "Sent to engineering",
      value: pct(recent.engineeringRate),
      hint: pctDelta(recent.engineeringRate, previous.engineeringRate),
      onClick: () =>
        open({
          title: "Sent to engineering",
          description: "Tickets from the last 28 days that got a dev-board item or a Slack escalation.",
          drill: { kind: "engineering" },
        }),
    },
    {
      label: "Live chats",
      value: chat ? chat.recent.real : "—",
      hint: chat ? countDelta(chat.recent.real, chat.previous.real) : undefined,
    },
  ];
  return <MetricRow metrics={metrics} />;
}

export function Load({ h, open }: { h: SupportHealth; open: Open }) {
  const metrics: MetricSpec[] = [
    {
      label: "Tickets with a Jetta draft",
      value: pct(h.recent.tickets ? h.load.ticketsDrafted / h.recent.tickets : null),
      hint: `${h.load.ticketsDrafted} of ${h.recent.tickets} · an agent reviews and sends each reply`,
      onClick: () =>
        open({
          title: "Tickets with a Jetta draft",
          description: "Tickets from the last 28 days where Jetta suggested at least one reply for an agent to review.",
          drill: { kind: "drafted" },
        }),
    },
    {
      label: "Chats finished by Jetta",
      value: h.chat ? pct(h.chat.recent.real ? h.chat.recent.alone / h.chat.recent.real : null) : "—",
      hint: h.chat ? `${h.chat.recent.alone} of ${h.chat.recent.real} with no ticket and no person` : undefined,
    },
  ];
  return (
    <Card id="load" className="scroll-mt-16 gap-2 py-4">
      <CardHeader className="px-4">
        <CardTitle>Who carried the load</CardTitle>
        <CardDescription className="text-xs">Last 28 days. Every email reply is still sent by a person.</CardDescription>
      </CardHeader>
      <CardContent className="px-4">
        <MetricRow metrics={metrics} className="sm:grid-cols-2" />
      </CardContent>
    </Card>
  );
}
