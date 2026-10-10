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

/**
 * The tickets behind a number — the side panel /health and /performance open
 * when a number, chart point or table cell is clicked. Each page decides which
 * tickets and the one column that says why each is there; this renders them.
 */
export interface TicketListRow {
  id: number;
  subject: string;
  app?: string;
  status: string;
  createdAt: string;
  topic?: string | null;
}

export interface TicketListColumn<R> {
  head: string;
  cell: (r: R) => React.ReactNode;
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en", { month: "short", day: "numeric" });

export function TicketListSheet<R extends TicketListRow>({
  open,
  title,
  description,
  summary,
  rows,
  column,
  error,
  notBuilt,
  base,
  onClose,
}: {
  open: boolean;
  title?: string;
  /** How the list was chosen — the same sentence as the number's definition. */
  description?: string;
  /** A one-line reading of the list: the number it adds up to. */
  summary?: string;
  /** Null while the first fetch is in flight. */
  rows: R[] | null;
  column: TicketListColumn<R> | null;
  error: string | null;
  /** The last sync predates the ticket lists: say so, rather than "no tickets". */
  notBuilt: boolean;
  base: string;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle || !rows) return rows ?? [];
    return rows.filter(
      (r) =>
        r.subject.toLowerCase().includes(needle) ||
        String(r.id).includes(needle.replace(/^#/, "")) ||
        (r.app && appName(r.app).toLowerCase().includes(needle)),
    );
  }, [rows, q]);
  const hasApp = !!rows?.some((r) => r.app);

  return (
    <Sheet
      open={open}
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
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription className="text-xs">{description}</SheetDescription>
          {rows && !notBuilt && (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium tabular-nums">{summary}</p>
              {rows.length > 8 && (
                <Input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Filter by subject, #id or app"
                  aria-label="Filter tickets"
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
            <EmptyState
              title="The ticket lists haven't been built yet"
              hint="Each sync builds them. Press Sync now on the page (a minute or two), or wait for the hourly run, then click the number again."
            />
          ) : !rows ? (
            <div className="grid gap-2 pt-4">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="h-8" />
              ))}
            </div>
          ) : shown.length && column ? (
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-background">
                <TableRow>
                  <TableHead>Ticket</TableHead>
                  {hasApp && <TableHead className="hidden sm:table-cell">App</TableHead>}
                  <TableHead className="hidden md:table-cell">Status now</TableHead>
                  <TableHead className="hidden sm:table-cell">Arrived</TableHead>
                  <TableHead className="text-right">{column.head}</TableHead>
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
                      {(r.app || r.topic) && (
                        <p className="truncate text-xs text-muted-foreground">
                          {r.app && <span className="sm:hidden">{appName(r.app)}</span>}
                          {r.topic && (
                            <>
                              {r.app && <span className="sm:hidden"> · </span>}
                              <span className="first-letter:uppercase">{r.topic}</span>
                            </>
                          )}
                        </p>
                      )}
                    </TableCell>
                    {hasApp && (
                      <TableCell
                        className={cn("hidden whitespace-nowrap sm:table-cell", r.app === "unknown" && "text-muted-foreground")}
                      >
                        {r.app ? appName(r.app) : "—"}
                      </TableCell>
                    )}
                    <TableCell className="hidden whitespace-nowrap text-muted-foreground md:table-cell">{r.status}</TableCell>
                    <TableCell className="hidden whitespace-nowrap text-muted-foreground tabular-nums sm:table-cell">
                      {day(r.createdAt)}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap tabular-nums">{column.cell(r)}</TableCell>
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
