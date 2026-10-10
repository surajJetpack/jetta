"use client";

import { useMemo } from "react";
import { TicketListSheet, type TicketListColumn } from "@/components/jetta/ticket-list-sheet";
import { cn } from "@/lib/utils";
import { TARGETS, drillRows, hitWithin, type Drill, type HealthRow } from "@/lib/support-health";
import { fmtHours } from "@/lib/format";

export interface DrillRequest {
  title: string;
  /** How the list was chosen — the same sentence as the number's definition. */
  description: string;
  drill: Drill;
}

const OUTCOME: Record<string, string> = {
  real_bug: "Real bug",
  knowledge_gap: "Knowledge gap",
  feature_request: "Feature request",
};

/** The one column that says why this ticket is in this number. */
function valueColumn(d: Drill, now: number): TicketListColumn<HealthRow> {
  const firstReply = (hours: number | null) => ({
    head: "First reply",
    cell: (r: HealthRow) => {
      const hit = hours == null ? null : hitWithin(r, hours, now);
      return (
        <span className={cn(hit === false && "font-medium text-tone-bad")}>
          {r.firstReplyH == null ? (hit === false ? "no reply yet" : "—") : fmtHours(r.firstReplyH)}
        </span>
      );
    },
  });
  const waiting = {
    head: "Waiting",
    cell: (r: HealthRow) => (
      <span className={cn(r.waitingH != null && r.waitingH > TARGETS.firstReplyH && "font-medium text-tone-bad")}>
        {r.bucket === "owes_reply" ? fmtHours(r.waitingH) : "—"}
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
      return { head: "Resolved in", cell: (r) => fmtHours(r.resolvedH) };
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
  notBuilt,
  now,
  base,
  onClose,
}: {
  request: DrillRequest | null;
  /** Null while the first fetch is in flight. */
  rows: HealthRow[] | null;
  error: string | null;
  notBuilt: boolean;
  now: number;
  base: string;
  onClose: () => void;
}) {
  const list = useMemo(() => (request && rows ? drillRows(rows, request.drill, now) : null), [request, rows, now]);
  return (
    <TicketListSheet
      open={!!request}
      title={request?.title}
      description={request?.description}
      summary={request && list ? summary(request.drill, list, now) : undefined}
      rows={list}
      column={request ? valueColumn(request.drill, now) : null}
      error={error}
      notBuilt={notBuilt}
      base={base}
      onClose={onClose}
    />
  );
}
