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
import type { HandoffCategory, HandoffKind, HandoffStats, HandoffSummary } from "@/lib/performance";

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

export default function HandoffPanel({ h, ticketUrlBase }: { h: HandoffSummary; ticketUrlBase?: string }) {
  const r = h.recent;
  return (
    <Card className="py-4">
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
            { label: "Handed off, 28 days", value: r.total, hint: `${h.all.total} since Jetta went live` },
            { label: "Real bugs", value: r.real_bug, hint: share(r.real_bug, r) },
            { label: "Knowledge gaps", value: r.knowledge_gap, hint: share(r.knowledge_gap, r) },
            { label: "Other", value: r.other, hint: "features, account work, platform" },
            { label: "Awaiting outcome", value: r.awaiting, hint: "still open, judged once settled" },
          ]}
        />

        <div className="grid gap-6 md:grid-cols-2 [&>*]:min-w-0">
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">By week of the handoff</p>
            {h.weeks.length ? (
              <ChartContainer config={bucketConfig} className="h-[200px] w-full">
                <BarChart data={h.weeks} margin={{ left: -24, right: 0, top: 4 }}>
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
                    <TableCell className="text-right tabular-nums">{k.total}</TableCell>
                    <TableCell className="text-right tabular-nums">{k.real_bug}</TableCell>
                    <TableCell className="text-right tabular-nums">{k.knowledge_gap}</TableCell>
                    <TableCell className="text-right tabular-nums">{k.other}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{k.awaiting}</TableCell>
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
