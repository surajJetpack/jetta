"use client";

import { useMemo, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { EmptyState } from "@/components/jetta/empty-state";
import { appName } from "@/lib/types";
import { cn } from "@/lib/utils";
import { TARGETS, drillRows, hitWithin, type Drill, type HealthRow } from "@/lib/support-health";

export interface DrillRequest {
  title: string;
  /** How the list was chosen — the same sentence as the number's definition. */
  description: string;
  drill: Drill;
}

const hrs = (v: number | null) =>
  v == null ? "—" : v < 1 ? `${Math.round(v * 60)} min` : v < 48 ? `${v.toFixed(1)} h` : `${(v / 24).toFixed(1)} days`;
const day = (iso: string) => new Date(iso).toLocaleDateString("en", { month: "short", day: "numeric" });

const OUTCOME: Record<string, string> = {
  real_bug: "Real bug",
  knowledge_gap: "Knowledge gap",
  feature_request: "Feature request",
};

/** The one column that says why this ticket is in this number. */
function valueColumn(d: Drill, now: number): { head: string; cell: (r: HealthRow) => React.ReactNode } {
  const firstReply = (hours: number | null) => ({
    head: "First reply",
    cell: (r: HealthRow) => {
      const hit = hours == null ? null : hitWithin(r, hours, now);
      return (
        <span className={cn(hit === false && "font-medium text-tone-bad")}>
          {r.firstReplyH == null ? (hit === false ? "no reply yet" : "—") : hrs(r.firstReplyH)}
        </span>
      );
    },
  });
  const waiting = {
    head: "Waiting",
    cell: (r: HealthRow) => (
      <span className={cn(r.waitingH != null && r.waitingH > TARGETS.firstReplyH && "font-medium text-tone-bad")}>
        {r.bucket === "owes_reply" ? hrs(r.waitingH) : "—"}
      </span>
    ),
  };
  const reopened = {
    head: "Reopened",
    cell: (r: HealthRow) => (r.reopened ? <span className="font-medium text-tone-bad">Reopened</span> : "—"),
  };
  switch (d.kind) {
    case "within":
      return firstReply(d.hours);
    case "reopened":
      return reopened;
    case "resolved":
      return { head: "Resolved in", cell: (r) => hrs(r.resolvedH) };
    case "backAndForth":
      return { head: "Customer msgs", cell: (r) => r.customerMsgs };
    case "bucket":
      return waiting;
    case "week":
      if (d.metric === "within") return firstReply(TARGETS.firstReplyH);
      if (d.metric === "reopened") return reopened;
      return firstReply(null);
    case "app":
      if (d.metric === "reopened") return reopened;
      if (d.metric === "open" || d.metric === "owesReply") return waiting;
      if (d.metric === "bugs" || d.metric === "gaps")
        return { head: "Verdict", cell: (r) => (r.outcome ? OUTCOME[r.outcome] ?? r.outcome : "—") };
      return firstReply(null);
    default:
      return firstReply(null);
  }
}

/** A one-line reading of the list — the number it adds up to. */
function summary(d: Drill, rows: HealthRow[], now: number): string {
  const n = rows.length;
  const tickets = `${n} ticket${n === 1 ? "" : "s"}`;
  const hours = d.kind === "within" ? d.hours : d.kind === "week" && d.metric === "within" ? TARGETS.firstReplyH : null;
  if (hours != null) {
    const hit = rows.filter((r) => hitWithin(r, hours, now)).length;
    return `${hit} of ${tickets} answered within ${hours}h · ${n - hit} missed`;
  }
  if ((d.kind === "week" || d.kind === "app") && d.metric === "reopened") {
    return `${rows.filter((r) => r.reopened).length} of ${n} answered reopened`;
  }
  return tickets;
}

export function DrillSheet({
  request,
  rows,
  error,
  now,
  base,
  onClose,
}: {
  request: DrillRequest | null;
  /** Null while the first fetch is in flight. */
  rows: HealthRow[] | null;
  error: string | null;
  now: number;
  base: string;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const list = useMemo(() => (request && rows ? drillRows(rows, request.drill, now) : []), [request, rows, now]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return list;
    return list.filter(
      (r) =>
        r.subject.toLowerCase().includes(needle) ||
        String(r.id).includes(needle.replace(/^#/, "")) ||
        appName(r.app).toLowerCase().includes(needle),
    );
  }, [list, q]);
  const col = request ? valueColumn(request.drill, now) : null;

  return (
    <Sheet
      open={!!request}
      onOpenChange={(o) => {
        if (!o) {
          setQ("");
          onClose();
        }
      }}
    >
      {/* No autofocus: the filter box would pop the keyboard on a phone before anyone has read the list. */}
      <SheetContent className="gap-0 sm:max-w-3xl" onOpenAutoFocus={(e) => e.preventDefault()}>
        <SheetHeader className="border-b">
          <SheetTitle>{request?.title}</SheetTitle>
          <SheetDescription className="text-xs">{request?.description}</SheetDescription>
          {rows && request && (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium tabular-nums">{summary(request.drill, list, now)}</p>
              {list.length > 8 && (
                <Input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Filter by subject, #id or app"
                  className="h-8 w-full sm:w-64"
                />
              )}
            </div>
          )}
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {error ? (
            <Alert variant="destructive" className="mt-4">
              <TriangleAlert />
              <AlertTitle>{error}</AlertTitle>
            </Alert>
          ) : !rows ? (
            <div className="grid gap-2 pt-4">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="h-8" />
              ))}
            </div>
          ) : shown.length && col ? (
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-background">
                <TableRow>
                  <TableHead>Ticket</TableHead>
                  <TableHead className="hidden sm:table-cell">App</TableHead>
                  <TableHead className="hidden md:table-cell">Status now</TableHead>
                  <TableHead className="hidden sm:table-cell">Arrived</TableHead>
                  <TableHead className="text-right">{col.head}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((r) => (
                  <TableRow key={r.id}>
                    {/* max-w-0 + w-full: the subject takes what the other columns leave, and truncates there. */}
                    <TableCell className="w-full max-w-0 truncate">
                      <a href={`${base}${r.id}`} target="_blank" rel="noreferrer" className="hover:underline" title={r.subject}>
                        <span className="text-muted-foreground tabular-nums">#{r.id}</span> {r.subject}
                      </a>
                      <p className="truncate text-xs text-muted-foreground">
                        <span className="sm:hidden">{appName(r.app)}</span>
                        {r.topic && (
                          <>
                            <span className="sm:hidden"> · </span>
                            <span className="first-letter:uppercase">{r.topic}</span>
                          </>
                        )}
                      </p>
                    </TableCell>
                    <TableCell className={cn("hidden whitespace-nowrap sm:table-cell", r.app === "unknown" && "text-muted-foreground")}>
                      {appName(r.app)}
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap text-muted-foreground md:table-cell">{r.status}</TableCell>
                    <TableCell className="hidden whitespace-nowrap text-muted-foreground tabular-nums sm:table-cell">
                      {day(r.createdAt)}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap tabular-nums">{col.cell(r)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState title={q ? "Nothing matches that filter" : "No tickets behind this number"} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
