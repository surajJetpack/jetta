"use client";

import { useEffect, useState, useCallback } from "react";
import { BookOpen, RotateCw, TriangleAlert } from "lucide-react";
import { fmtCompact, fmtDate, fmtUsd } from "@/lib/format";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertAction, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StepCard } from "@/components/jetta/step-card";
import { StatusChip } from "@/components/jetta/status-chip";
import { SectionHeader } from "@/components/jetta/page-header";
import { BrandFilter, brandQuery, type Brand } from "@/components/jetta/brand-filter";

interface Gap { ticketId: string; subject: string; reason: string; at: number; url: string }
interface ModelStat {
  model: string;
  drafts: number;
  approved: number;
  edited: number;
  discarded: number;
  runs: number;
  escalated: number;
  reopened: number;
  approvalRate: number | null;
  editRate: number | null;
  tokens: {
    runs: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    avgTokensPerRun: number;
    estCostUsd: number | null;
  } | null;
}

interface Stats {
  outcomes: { total: number; resolved: number; escalated: number; reopened: number; closed: number; deflectionRate: number | null };
  gaps: Gap[];
  gapKeywords: { term: string; count: number }[];
  toolUsage: { tool: string; count: number }[];
  approvedArticles: { title: string; approvedBy: string; at: number }[];
  models?: ModelStat[];
  taskTokens?: { task: string; calls: number; inputTokens: number; outputTokens: number }[];
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-1.5 flex items-center gap-2 text-xl font-semibold tracking-tight tabular-nums">{children}</div>
    </div>
  );
}

export default function AnalyticsPanel() {
  const [s, setS] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [brand, setBrand] = useState<Brand>(null);

  // State updates live in promise callbacks (not the function body) so the
  // mount effect satisfies react-hooks/set-state-in-effect; initial
  // loading=true covers the first fetch.
  const load = useCallback(() => {
    fetch(`/api/admin/stats${brandQuery(brand)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        setS(d as Stats);
        setErr(null);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [brand]);

  useEffect(() => { load(); }, [load]);

  const refresh = () => {
    setLoading(true);
    setErr(null);
    void load();
  };

  const o = s?.outcomes;
  const pct = o?.deflectionRate != null ? `${Math.round(o.deflectionRate * 100)}%` : "—";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Learning &amp; gap analytics</CardTitle>
        <CardAction className="flex items-center gap-2">
          <BrandFilter value={brand} onChange={setBrand} disabled={loading} />
          <Button variant="ghost" size="sm" onClick={refresh} disabled={loading}>
            <RotateCw className={loading ? "animate-spin" : undefined} /> Refresh
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        {err && (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>{err}</AlertTitle>
            <AlertAction>
              <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
                Retry
              </Button>
            </AlertAction>
          </Alert>
        )}

        {loading && !s && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
            </div>
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-2/3" />
          </div>
        )}

        {o && s && (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              <Stat label="Runs logged">{o.total}</Stat>
              <Stat label="Deflection rate">{pct}</Stat>
              <Stat label="Escalated">{o.escalated}</Stat>
              <Stat label="Reopened">{o.reopened}</Stat>
              <Stat label="Auto-closed">{o.closed}</Stat>
              <Stat label="KB articles learned">{s.approvedArticles.length}</Stat>
            </div>

            <div className="space-y-2">
              <SectionHeader>Knowledge gaps — document these next ({s.gaps.length})</SectionHeader>
              {s.gaps.length ? (
                s.gaps.slice(0, 12).map((g) => (
                  <StepCard
                    key={g.ticketId}
                    title={
                      <a href={g.url} target="_blank" rel="noreferrer" className="hover:underline">
                        #{g.ticketId}
                      </a>
                    }
                    meta={<StatusChip tone={g.reason === "reopened" ? "draft" : "published"}>{g.reason}</StatusChip>}
                  >
                    <p className="text-xs text-muted-foreground">{g.subject}</p>
                  </StepCard>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">
                  No escalations or reopens logged yet — Jetta is closing everything herself, or there&apos;s no traffic.
                </p>
              )}
            </div>

            {s.gapKeywords.length > 0 && (
              <div className="space-y-2">
                <SectionHeader>Recurring gap themes</SectionHeader>
                <div className="flex flex-wrap gap-1.5">
                  {s.gapKeywords.map((k) => (
                    <StatusChip key={k.term}>
                      {k.term} · {k.count}
                    </StatusChip>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-2">
              <SectionHeader>Learned via the Knowledge Loop ({s.approvedArticles.length})</SectionHeader>
              {s.approvedArticles.length ? (
                <ul className="space-y-1.5">
                  {s.approvedArticles.slice(0, 10).map((a, i) => (
                    <li key={i} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                      <span className="inline-flex items-center gap-1.5 font-medium">
                        <BookOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                        {a.title}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        approved by {a.approvedBy} · {fmtDate(a.at)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No articles approved yet. When a dev resolves an escalation in Slack, run{" "}
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">@Jetta draft kb</code> →{" "}
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">@Jetta publish kb</code>.
                </p>
              )}
            </div>

            {(s.models?.length ?? 0) > 0 && (
              <div className="space-y-2">
                <SectionHeader>Model quality — evidence for tiered routing</SectionHeader>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Model</TableHead>
                      <TableHead className="text-right">Drafts</TableHead>
                      <TableHead className="text-right">Approved</TableHead>
                      <TableHead className="text-right">Edited</TableHead>
                      <TableHead className="text-right">Discarded</TableHead>
                      <TableHead className="text-right">Approval %</TableHead>
                      <TableHead>Tokens</TableHead>
                      <TableHead className="text-right">Est. cost</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {s.models!.map((m) => (
                      <TableRow key={m.model}>
                        <TableCell>
                          <div className="font-medium">{m.model}</div>
                          <div className="text-xs text-muted-foreground">
                            {m.runs} runs · {m.escalated} escalated · {m.reopened} reopened
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">{m.drafts}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{m.approved}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{m.edited}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{m.discarded}</TableCell>
                        <TableCell className="text-right">
                          {m.drafts > 0 ? (
                            m.approvalRate != null ? (
                              <StatusChip tone={m.approvalRate < 0.8 ? "draft" : "published"}>
                                {Math.round(m.approvalRate * 100)}%
                              </StatusChip>
                            ) : (
                              <span className="text-xs text-muted-foreground">no decisions yet</span>
                            )
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {m.tokens ? (
                            <>
                              {fmtCompact(m.tokens.inputTokens)} in
                              {m.tokens.cacheReadTokens > 0 ? ` (${fmtCompact(m.tokens.cacheReadTokens)} cached)` : ""} /{" "}
                              {fmtCompact(m.tokens.outputTokens)} out · avg {fmtCompact(m.tokens.avgTokensPerRun)}/run
                            </>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {m.tokens?.estCostUsd != null
                            ? `~${fmtUsd(m.tokens.estCostUsd)}`
                            : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {(s.taskTokens?.length ?? 0) > 0 && (
              <div className="space-y-2">
                <SectionHeader>Token consumption by task</SectionHeader>
                <div className="flex flex-wrap gap-1.5">
                  {s.taskTokens!.map((t) => (
                    <StatusChip key={t.task} className="font-mono">
                      {t.task} · {fmtCompact(t.inputTokens + t.outputTokens)} ({fmtCompact(t.inputTokens)} in /{" "}
                      {fmtCompact(t.outputTokens)} out) · {t.calls} calls
                    </StatusChip>
                  ))}
                </div>
              </div>
            )}

            {s.toolUsage.length > 0 && (
              <div className="space-y-2">
                <SectionHeader>Tool usage</SectionHeader>
                <div className="flex flex-wrap gap-1.5">
                  {s.toolUsage.map((t) => (
                    <StatusChip key={t.tool} className="font-mono">
                      {t.tool} · {t.count}
                    </StatusChip>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
