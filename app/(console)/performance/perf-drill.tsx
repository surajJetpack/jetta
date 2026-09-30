"use client";

import { useMemo } from "react";
import { TicketListSheet, type TicketListColumn } from "@/components/jetta/ticket-list-sheet";
import { cn } from "@/lib/utils";
import { perfDrillRows, type HandoffBucket, type PerfDrill, type PerfRow, type SuggestionUse } from "@/lib/performance";

export interface PerfDrillRequest {
  title: string;
  /** How the list was chosen — the same sentence as the number's definition. */
  description: string;
  drill: PerfDrill;
}

/** Opens the tickets behind a number. */
export type OpenPerf = (r: PerfDrillRequest) => void;

const hrs = (v: number | null) => (v == null ? "—" : v < 1 ? `${Math.round(v * 60)} min` : `${v.toFixed(1)} h`);

const USE_LABEL: Record<SuggestionUse, string> = { as_is: "as-is", edited: "edited", not_used: "not used" };
const BUCKET_LABEL: Record<HandoffBucket, string> = {
  real_bug: "Real bug",
  knowledge_gap: "Knowledge gap",
  other: "Other",
  awaiting: "Awaiting outcome",
};

/** "1 of 3 used" — the ticket's judged drafts (one agent's only, if given); the breakdown on hover. */
function uses(r: PerfRow, agent?: string) {
  const list = r.uses.filter((u) => u.use && (!agent || u.replyBy === agent));
  if (!list.length) return "—";
  const used = list.filter((u) => u.use !== "not_used").length;
  return (
    <span title={list.map((u) => USE_LABEL[u.use!]).join(", ")} className={cn(used === 0 && "text-tone-bad")}>
      {list.length === 1 ? USE_LABEL[list[0].use!] : `${used} of ${list.length} used`}
    </span>
  );
}

function column(d: PerfDrill): TicketListColumn<PerfRow> {
  const firstReply: TicketListColumn<PerfRow> = {
    head: "First reply",
    cell: (r) => (
      <span>
        {hrs(r.firstReplyH)}
        {r.firstReplyBy && <span className="ml-1 text-xs text-muted-foreground">{r.firstReplyBy}</span>}
      </span>
    ),
  };
  switch (d.kind) {
    case "coverage":
      return { head: "Jetta draft", cell: (r) => (r.uses.length ? `${r.uses.length} draft${r.uses.length === 1 ? "" : "s"}` : <span className="text-tone-bad">none</span>) };
    case "used":
      return { head: "Drafts", cell: (r) => uses(r) };
    case "link":
      return { head: "First reply links a doc", cell: (r) => (r.firstReplyHasLink ? "Yes" : "—") };
    case "reopened":
      return { head: "Reopened", cell: () => <span className="font-medium text-tone-bad">Reopened</span> };
    case "week":
      return d.metric === "drafts" ? { head: "Drafts", cell: (r) => uses(r) } : firstReply;
    case "agent":
      return d.metric === "afterSuggestion" ? { head: "Drafts", cell: (r) => uses(r, d.agent) } : firstReply;
    case "handoffs":
      return {
        head: "Outcome",
        cell: (r) => (r.handoffBucket ? BUCKET_LABEL[r.handoffBucket] : "—"),
      };
    default:
      return firstReply;
  }
}

function summary(d: PerfDrill, rows: PerfRow[]): string {
  const n = rows.length;
  const tickets = `${n} ticket${n === 1 ? "" : "s"}`;
  const judgedUses = (agent?: string) => rows.flatMap((r) => r.uses.filter((u) => u.use && (!agent || u.replyBy === agent)));
  switch (d.kind) {
    case "coverage":
      return `${rows.filter((r) => r.uses.length).length} of ${n} answered tickets had a Jetta draft`;
    case "link":
      return `${rows.filter((r) => r.firstReplyHasLink).length} of ${n} first replies link a doc`;
    case "used":
    case "week":
    case "agent": {
      if (d.kind === "week" && d.metric !== "drafts") return tickets;
      if (d.kind === "agent" && d.metric !== "afterSuggestion") return tickets;
      const u = judgedUses(d.kind === "agent" ? d.agent : undefined);
      const used = u.filter((x) => x.use !== "not_used").length;
      return `${used} of ${u.length} drafts used, on ${tickets}`;
    }
    default:
      return tickets;
  }
}

export function PerfDrillSheet({
  request,
  rows,
  error,
  notBuilt,
  now,
  base,
  onClose,
}: {
  request: PerfDrillRequest | null;
  rows: PerfRow[] | null;
  error: string | null;
  notBuilt: boolean;
  now: number;
  base: string;
  onClose: () => void;
}) {
  const list = useMemo(() => (request && rows ? perfDrillRows(rows, request.drill, now) : null), [request, rows, now]);
  return (
    <TicketListSheet
      open={!!request}
      title={request?.title}
      description={request?.description}
      summary={request && list ? summary(request.drill, list) : undefined}
      rows={list}
      column={request ? column(request.drill) : null}
      error={error}
      notBuilt={notBuilt}
      base={base}
      onClose={onClose}
    />
  );
}
