"use client";

import { useMemo, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { EmptyState } from "@/components/jetta/empty-state";
import { StatusChip } from "@/components/jetta/status-chip";
import { drillRows, KIND_LABEL, type DevDrill, type DevRow } from "@/lib/dev-board";
import { fmtDate } from "@/lib/format";

export interface DevDrillRequest {
  title: string;
  description: string;
  drill: DevDrill;
}
export type OpenDev = (r: DevDrillRequest) => void;

const DAY = 86_400_000;
export const fmtDays = (ms: number) => {
  const d = ms / DAY;
  return d < 1 ? `${Math.max(1, Math.round(ms / 3_600_000))}h` : `${Math.round(d)}d`;
};

/** The one fact that explains why this item is in this list. */
function why(r: DevRow, d: DevDrill, now: number): string {
  switch (d.kind) {
    case "firstEng":
      return r.firstEngAt ? `first reply after ${fmtDays(r.firstEngAt - r.createdAt)}` : `no reply yet (${fmtDays(now - r.createdAt)})`;
    case "cycle":
    case "resolved":
      return r.resolvedAt ? `resolved in ${fmtDays(r.resolvedAt - r.createdAt)}` : "";
    case "open":
    case "dev":
    case "support":
      if (r.move) return `${r.move === "engineering" ? "engineering" : r.move === "support" ? "support" : "customer"}'s move · ${fmtDays(now - (r.waitingSince ?? r.createdAt))}`;
      return r.resolvedAt ? `resolved ${fmtDate(r.resolvedAt / 1000)}` : "";
    case "dormant":
      return `untouched ${fmtDays(now - r.lastActionAt)}`;
    case "bounced":
      return `came back ${r.bounceAts.length}×`;
    case "nudges":
      return `${r.nudgeAts.length} nudge${r.nudgeAts.length === 1 ? "" : "s"}`;
    default:
      return r.kind ? KIND_LABEL[r.kind] : `filed ${fmtDate(r.createdAt / 1000)}`;
  }
}

/** The items behind a number. Each links to monday; a mined item shows what its conversation taught. */
export function DevDrillSheet({
  request,
  rows,
  error,
  notBuilt,
  now,
  onClose,
}: {
  request: DevDrillRequest | null;
  rows: DevRow[] | null;
  error: string | null;
  notBuilt: boolean;
  now: number;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const list = useMemo(() => (request && rows ? drillRows(rows, request.drill, now) : null), [request, rows, now]);
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    if (!n || !list) return list ?? [];
    return list.filter((r) =>
      [r.name, r.app, r.status ?? "", r.area ?? "", ...r.developers, ...r.support].some((s) => s.toLowerCase().includes(n)),
    );
  }, [list, q]);

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
      <SheetContent className="gap-0 sm:max-w-3xl" onOpenAutoFocus={(e) => e.preventDefault()}>
        <SheetHeader className="border-b">
          <SheetTitle>{request?.title}</SheetTitle>
          <SheetDescription className="text-xs">{request?.description}</SheetDescription>
          {list && (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium tabular-nums">
                {list.length} item{list.length === 1 ? "" : "s"}
              </p>
              {list.length > 8 && (
                <Input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Filter by name, app, person or status"
                  aria-label="Filter items"
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
          ) : notBuilt ? (
            <EmptyState title="The item lists haven't been built yet" hint="Press Sync now on the page, then click the number again." />
          ) : !list ? (
            <div className="grid gap-2 pt-4">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : !shown.length ? (
            <EmptyState title="No items" />
          ) : (
            <ul className="divide-y">
              {shown.map((r) => (
                <li key={r.id} className="grid gap-1 py-3">
                  <div className="flex min-w-0 items-baseline justify-between gap-3">
                    <a href={r.url} target="_blank" rel="noreferrer" className="min-w-0 truncate text-sm font-medium hover:underline" title={r.name}>
                      {r.name}
                    </a>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{request && why(r, request.drill, now)}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span>{r.app}</span>
                    {r.status && <StatusChip tone="archived">{r.status}</StatusChip>}
                    {r.developers.length > 0 && <span>dev: {r.developers.join(", ")}</span>}
                    {r.filedBy && <span>filed by {r.filedBy}</span>}
                    <span>{fmtDate(r.createdAt / 1000)}</span>
                    {r.area && <span>· {r.area}</span>}
                  </div>
                  {(r.rootCause || r.lesson) && (
                    <div className="grid gap-0.5 text-xs">
                      {r.rootCause && (
                        <p>
                          <span className="text-muted-foreground">Cause:</span> {r.rootCause}
                        </p>
                      )}
                      {r.lesson && (
                        <p>
                          <span className="text-muted-foreground">For the next customer:</span> {r.lesson}
                        </p>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
