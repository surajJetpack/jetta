"use client";

import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import { ExternalLink, HandCoins, History, Hourglass } from "lucide-react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusChip, type ChipTone } from "@/components/jetta/status-chip";
import { EmptyState } from "@/components/jetta/empty-state";
import { RelativeTime } from "@/components/jetta/relative-time";
import { usePolling } from "@/lib/use-polling";
import { summary, type MonetApproval } from "./billing-queue";

/** lib/kv MonetDecision, plus the decider's display name from the API. */
interface MonetDecision extends Omit<MonetApproval, "createdAt"> {
  outcome: "applied" | "rejected" | "failed";
  actor: string;
  decidedBy: string;
  message: string;
  direct?: boolean;
  requestedAt?: number;
  decidedAt: number;
}

const OUTCOMES: { id: MonetDecision["outcome"]; label: string; tone: ChipTone }[] = [
  { id: "applied", label: "Approved", tone: "published" },
  { id: "rejected", label: "Rejected", tone: "archived" },
  { id: "failed", label: "Not applied", tone: "stale" },
];
const OUTCOME = Object.fromEntries(OUTCOMES.map((o) => [o.id, o]));

const TYPES = [
  { id: "trial", label: "Trials" },
  { id: "discount", label: "Discounts" },
] as const;

/** "2h", "3d" — how long a request sat before someone decided it. */
function waited(from: number, to: number): string {
  const m = Math.max(0, Math.round((to - from) / 60));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

export default function BillingHistory({
  freshdeskDomain,
  reloadRef,
}: {
  freshdeskDomain: string;
  /** Filled with this card's reload, so a decision in the queue shows here at once. */
  reloadRef?: RefObject<(() => void) | null>;
}) {
  const [history, setHistory] = useState<MonetDecision[] | null>(null);
  const [outcome, setOutcome] = useState<MonetDecision["outcome"] | undefined>();
  const [type, setType] = useState<MonetDecision["action"] | undefined>();

  const load = useCallback(async () => {
    const r = await fetch("/api/admin/monetization?history", { cache: "no-store" }).then((x) => x.json());
    setHistory(r.history ?? []);
  }, []);
  usePolling(load, 60_000);
  useEffect(() => {
    if (reloadRef) reloadRef.current = () => void load();
  }, [reloadRef, load]);

  const byType = useMemo(() => (history ?? []).filter((d) => !type || d.action === type), [history, type]);
  const rows = useMemo(() => byType.filter((d) => !outcome || d.outcome === outcome), [byType, outcome]);
  const count = (o: MonetDecision["outcome"]) => byType.filter((d) => d.outcome === o).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="inline-flex items-center gap-1.5">
          <History className="size-4" /> History
        </CardTitle>
        <CardDescription>
          Every trial and discount decision, newest first — from this page, from Slack, and admins&apos; direct
          Slack grants. &ldquo;Not applied&rdquo; means someone approved but monday didn&apos;t take it; the request
          stayed in the queue.
        </CardDescription>
        <CardAction>
          <Button variant="ghost" size="sm" onClick={() => { setHistory(null); void load(); }}>
            Refresh
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border p-0.5" role="group" aria-label="Outcome">
            <Button size="sm" variant={!outcome ? "secondary" : "ghost"} className="h-7" aria-pressed={!outcome} onClick={() => setOutcome(undefined)}>
              All{history ? ` ${byType.length}` : ""}
            </Button>
            {OUTCOMES.map((o) => (
              <Button
                key={o.id}
                size="sm"
                variant={outcome === o.id ? "secondary" : "ghost"}
                className="h-7"
                aria-pressed={outcome === o.id}
                onClick={() => setOutcome(outcome === o.id ? undefined : o.id)}
              >
                {o.label}
                {history ? ` ${count(o.id)}` : ""}
              </Button>
            ))}
          </div>
          <div className="inline-flex rounded-md border p-0.5" role="group" aria-label="Type">
            {TYPES.map((t) => (
              <Button
                key={t.id}
                size="sm"
                variant={type === t.id ? "secondary" : "ghost"}
                className="h-7"
                aria-pressed={type === t.id}
                onClick={() => setType(type === t.id ? undefined : t.id)}
              >
                {t.label}
              </Button>
            ))}
          </div>
        </div>

        {history === null ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-2/3" />
          </div>
        ) : rows.length ? (
          <div className="max-h-[70vh] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Decided</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Request</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Ticket</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead className="text-right">Waited</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((d, i) => (
                  <TableRow key={`${d.id}-${d.decidedAt}-${i}`} title={d.message}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      <RelativeTime at={d.decidedAt} />
                    </TableCell>
                    <TableCell>
                      <StatusChip tone={OUTCOME[d.outcome].tone}>{OUTCOME[d.outcome].label}</StatusChip>
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5">
                        {d.action === "trial" ? <Hourglass className="size-3.5" /> : <HandCoins className="size-3.5" />}
                        {summary(d)}
                      </span>
                      {d.flagged && <span className="block text-xs text-tone-bad">Flagged: {d.flagged}</span>}
                    </TableCell>
                    <TableCell>
                      <code className="font-mono text-xs">{d.accountSlug}</code>
                      <span className="block font-mono text-xs text-muted-foreground">{d.app}</span>
                    </TableCell>
                    <TableCell>
                      {d.ticketId ? (
                        <a
                          href={`https://${freshdeskDomain}/a/tickets/${d.ticketId}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                        >
                          #{d.ticketId} <ExternalLink className="size-3.5" />
                        </a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {d.decidedBy}
                      <span className="block text-xs text-muted-foreground">
                        {d.direct ? "Slack · direct" : d.actor.startsWith("slack:") ? "Slack" : "Console"}
                      </span>
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap text-muted-foreground">
                      {d.requestedAt ? waited(d.requestedAt, d.decidedAt) : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState
            icon={History}
            title={history.length ? "Nothing matches these filters" : "No decisions recorded yet"}
            hint={
              history.length
                ? undefined
                : "Each approve or reject — here or in Slack — lands in this list. Decisions made before 6 Oct 2026 were not kept."
            }
          />
        )}
      </CardContent>
    </Card>
  );
}
