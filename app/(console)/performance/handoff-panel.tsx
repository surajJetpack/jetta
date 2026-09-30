"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { MetricRow } from "@/components/jetta/metric-row";
import { EmptyState } from "@/components/jetta/empty-state";
import { StatusChip } from "@/components/jetta/status-chip";
import { CellLink } from "@/components/jetta/cell-link";
import { cn } from "@/lib/utils";
import type { HandoffBucket, HandoffCategory, HandoffKind, HandoffStats, HandoffSummary } from "@/lib/performance";
import type { OpenPerf } from "./perf-drill";

const bucketConfig = {
  real_bug: { label: "Real bug", color: "var(--chart-5)" },
  knowledge_gap: { label: "Knowledge gap", color: "var(--chart-3)" },
  other: { label: "Other", color: "var(--chart-1)" },
  awaiting: { label: "Awaiting outcome", color: "var(--muted-foreground)" },
} satisfies ChartConfig;

const KIND_LABEL: Record<HandoffKind, string> = {
  dev_item: "Filed a dev item",
  slack: "Escalated in Slack",
  chat: "Live chat she couldn't finish",
};

const BUCKET_TITLE: Record<HandoffBucket, string> = {
  real_bug: "real bugs",
  knowledge_gap: "knowledge gaps",
  other: "other",
  awaiting: "awaiting outcome",
};

const CATEGORY_LABEL: Record<HandoffCategory, string> = {
  real_bug: "Real bug",
  knowledge_gap: "Knowledge gap",
  feature_request: "Feature request",
  account_action: "Needed account access",
  customer_environment: "monday / third party",
  unresolved: "Awaiting outcome",
};

const weekTick = (w: string) =>
  new Date(`${w}T00:00:00Z`).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });
const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });

/** Share of the handoffs that have an outcome — awaiting ones would dilute every rate. */
function share(n: number, s: HandoffStats): string {
  const judged = s.total - s.awaiting;
  return judged ? `${Math.round((n / judged) * 100)}% of judged` : "—";
}

function TicketLink({ id, subject, base }: { id: number; subject: string; base?: string }) {
  const label = (
    <>
      <span className="text-muted-foreground tabular-nums">#{id}</span> {subject}
    </>
  );
  return base ? (
    <a href={`${base}${id}`} target="_blank" rel="noreferrer" className="hover:underline">
      {label}
    </a>
  ) : (
    label
  );
}

function Coverage({ c, article }: { c: "covered" | "partly_covered" | "not_covered" | null; article: string | null }) {
  if (c === "covered") return <span title={article ?? undefined}><StatusChip tone="published">In KB</StatusChip></span>;
  if (c === "partly_covered") return <span title={article ?? undefined}><StatusChip tone="draft">Partly</StatusChip></span>;
  return <StatusChip tone="stale">Not in KB</StatusChip>;
}

export default function HandoffPanel({ h, ticketUrlBase, open }: { h: HandoffSummary; ticketUrlBase?: string; open: OpenPerf }) {
  const recentList = (bucket: HandoffBucket | "total", title: string, description: string) => () =>
    open({ title, description, drill: { kind: "handoffs", bucket, scope: "recent" } });
  const routeList = (route: HandoffKind, bucket: HandoffBucket | "total", n: number) => ({
    n,
    onClick: () =>
      open({
        title: `${KIND_LABEL[route]} · ${bucket === "total" ? "all handoffs" : BUCKET_TITLE[bucket]}`,
        description: "Handoffs by this route since Jetta went live, newest first.",
        drill: { kind: "handoffs", bucket, scope: "all", route },
      }),
  });
  const r = h.recent;
  return (
    <Card id="handoffs" className="scroll-mt-16 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Handoffs: real bugs or knowledge gaps?</CardTitle>
        <CardDescription className="text-xs">
          Every ticket Jetta passed to people — a dev item, a Slack escalation, or a chat she couldn&apos;t finish —
          judged by what happened next: engineering&apos;s comments on the dev item and the agents&apos; later
          replies. A knowledge gap is one where the answer turned out to be a fact she didn&apos;t have.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 px-4">
        <MetricRow
          metrics={[
            {
              label: "Handed off, 28 days",
              value: r.total,
              hint: `${h.all.total} since Jetta went live`,
              onClick: recentList("total", "Handed off, last 28 days", "Every ticket Jetta passed to people in the last 28 days, newest first."),
            },
            {
              label: "Real bugs",
              value: r.real_bug,
              hint: share(r.real_bug, r),
              onClick: recentList("real_bug", "Real bugs", "Handoffs in the last 28 days that needed a developer."),
            },
            {
              label: "Knowledge gaps",
              value: r.knowledge_gap,
              hint: share(r.knowledge_gap, r),
              onClick: recentList("knowledge_gap", "Knowledge gaps", "Handoffs in the last 28 days that only needed a fact Jetta didn't have."),
            },
            {
              label: "Other",
              value: r.other,
              hint: "features, account work, platform",
              onClick: recentList("other", "Other handoffs", "Feature requests, account work and platform issues from the last 28 days."),
            },
            {
              label: "Awaiting outcome",
              value: r.awaiting,
              hint: "still open, judged once settled",
              onClick: recentList("awaiting", "Awaiting outcome", "Handoffs from the last 28 days not judged yet — still open, judged once settled."),
            },
          ]}
        />

        <div className="grid gap-6 md:grid-cols-2 [&>*]:min-w-0">
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">By week of the handoff</p>
            {h.weeks.length ? (
              <ChartContainer config={bucketConfig} className="h-[200px] w-full cursor-pointer">
                <BarChart
                  data={h.weeks}
                  margin={{ left: -24, right: 0, top: 4 }}
                  onClick={(state: { activeLabel?: string | number }) => {
                    if (state.activeLabel == null) return;
                    const week = String(state.activeLabel);
                    open({
                      title: `Handoffs · week of ${weekTick(week)}`,
                      description: "Tickets Jetta passed to people this week, with what each turned out to be.",
                      drill: { kind: "handoffs", bucket: "total", scope: "all", week },
                    });
                  }}
                >
                  <CartesianGrid vertical={false} strokeOpacity={0.4} />
                  <XAxis dataKey="week" tickFormatter={weekTick} tickLine={false} axisLine={false} fontSize={10} />
                  <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={10} />
                  <ChartTooltip content={<ChartTooltipContent labelFormatter={(w) => `Week of ${weekTick(String(w))}`} />} />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Bar dataKey="real_bug" stackId="h" fill="var(--color-real_bug)" stroke="var(--card)" strokeWidth={2} />
                  <Bar dataKey="knowledge_gap" stackId="h" fill="var(--color-knowledge_gap)" stroke="var(--card)" strokeWidth={2} />
                  <Bar dataKey="other" stackId="h" fill="var(--color-other)" stroke="var(--card)" strokeWidth={2} />
                  <Bar dataKey="awaiting" stackId="h" fill="var(--color-awaiting)" fillOpacity={0.35} stroke="var(--card)" strokeWidth={2} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ChartContainer>
            ) : (
              <EmptyState title="No handoffs yet" />
            )}
          </div>
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">By how she handed it off, since launch</p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Route</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Bug</TableHead>
                  <TableHead className="text-right">Gap</TableHead>
                  <TableHead className="text-right">Other</TableHead>
                  <TableHead className="text-right">Awaiting</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {h.byKind.map((k) => (
                  <TableRow key={k.kind}>
                    <TableCell>{KIND_LABEL[k.kind]}</TableCell>
                    {(["total", "real_bug", "knowledge_gap", "other", "awaiting"] as const).map((b) => (
                      <TableCell key={b} className={cn("text-right tabular-nums", b === "awaiting" && "text-muted-foreground")}>
                        <CellLink {...routeList(k.kind, b, k[b])}>{k[b]}</CellLink>
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="mt-2 text-xs text-muted-foreground">
              A ticket can take more than one route, so rows can add up to more than the total.
            </p>
          </div>
        </div>

        <div>
          <p className="mb-1 text-sm font-medium">Knowledge gaps to fill ({h.gaps.length})</p>
          <p className="mb-3 text-xs text-muted-foreground">
            What Jetta needed to know to answer these herself. &ldquo;Not in KB&rdquo; means the closest published
            articles don&apos;t state it — writing that article is the fix.
          </p>
          {h.gaps.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">Date</TableHead>
                  <TableHead className="w-64">Ticket</TableHead>
                  <TableHead>What Jetta needed to know</TableHead>
                  <TableHead className="w-56">Suggested article</TableHead>
                  <TableHead className="w-24">KB</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {h.gaps.map((g) => (
                  <TableRow key={g.ticketId} className="align-top">
                    <TableCell className="whitespace-nowrap text-muted-foreground">{day(g.at)}</TableCell>
                    <TableCell className="whitespace-normal">
                      <TicketLink id={g.ticketId} subject={g.subject} base={ticketUrlBase} />
                    </TableCell>
                    <TableCell className="whitespace-normal text-xs leading-relaxed">{g.missingKnowledge}</TableCell>
                    <TableCell className="whitespace-normal text-xs">{g.kbArticleTitle ?? "—"}</TableCell>
                    <TableCell>
                      <Coverage c={g.kbCoverage} article={g.kbArticle} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState title="No knowledge gaps judged yet" />
          )}
        </div>

        <details className="group">
          <summary className="cursor-pointer text-sm font-medium">Real bugs ({h.bugs.length})</summary>
          <Table className="mt-3">
            <TableBody>
              {h.bugs.map((b) => (
                <TableRow key={b.ticketId} className="align-top">
                  <TableCell className="w-16 whitespace-nowrap text-muted-foreground">{day(b.at)}</TableCell>
                  <TableCell className="w-64 whitespace-normal">
                    <TicketLink id={b.ticketId} subject={b.subject} base={ticketUrlBase} />
                  </TableCell>
                  <TableCell className="whitespace-normal text-xs leading-relaxed">{b.evidence}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </details>

        {h.others.length > 0 && (
          <details className="group">
            <summary className="cursor-pointer text-sm font-medium">Everything else ({h.others.length})</summary>
            <Table className="mt-3">
              <TableBody>
                {h.others.map((o) => (
                  <TableRow key={o.ticketId} className="align-top">
                    <TableCell className="w-16 whitespace-nowrap text-muted-foreground">{day(o.at)}</TableCell>
                    <TableCell className="w-64 whitespace-normal">
                      <TicketLink id={o.ticketId} subject={o.subject} base={ticketUrlBase} />
                    </TableCell>
                    <TableCell className="w-40 text-xs">{CATEGORY_LABEL[o.category]}</TableCell>
                    <TableCell className="whitespace-normal text-xs leading-relaxed">{o.evidence}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
