"use client";

/** The per-app table on /health. Every cell opens the tickets behind it. */
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CellLink } from "@/components/jetta/cell-link";
import { EmptyState } from "@/components/jetta/empty-state";
import { fmtHours } from "@/lib/format";
import { appName } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { AppHealth } from "@/lib/support-health";
import type { DrillRequest } from "./drill-sheet";
import { pct, type Open } from "./health-shared";

function Delta({ now, before }: { now: number; before: number }) {
  if (!before && !now) return null;
  const d = now - before;
  if (!d) return <span className="text-muted-foreground">±0</span>;
  return <span className="text-muted-foreground">{d > 0 ? `+${d}` : `−${-d}`}</span>;
}

export function ByApp({ apps, open }: { apps: AppHealth[]; open: Open }) {
  const show = (a: AppHealth, metric: Extract<DrillRequest["drill"], { kind: "app" }>["metric"], title: string, description: string) =>
    open({ title: `${appName(a.app)} · ${title}`, description, drill: { kind: "app", app: a.app, metric } });
  return (
    <Card id="by-app" className="scroll-mt-16 py-4">
      <CardHeader className="px-4">
        <CardTitle>By app, last 28 days</CardTitle>
        <CardDescription className="text-xs">
          Bugs and knowledge gaps come from reviewing each ticket Jetta handed to people: did it need a developer, or
          just an answer she didn&apos;t have?
        </CardDescription>
      </CardHeader>
      <CardContent className="px-4">
        {apps.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>App</TableHead>
                <TableHead className="text-right">Tickets</TableHead>
                <TableHead className="text-right">Median first reply</TableHead>
                <TableHead className="text-right">Reopened</TableHead>
                <TableHead className="text-right">Open · waiting on us</TableHead>
                <TableHead className="text-right">Real bugs</TableHead>
                <TableHead className="text-right">Knowledge gaps</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apps.map((a) => (
                <TableRow key={a.app}>
                  <TableCell className={cn("font-medium", a.app === "unknown" && "text-muted-foreground")}>
                    {appName(a.app)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <CellLink n={a.tickets} onClick={() => show(a, "tickets", "tickets", "Tickets from the last 28 days.")}>
                      {a.tickets}
                    </CellLink>{" "}
                    <Delta now={a.tickets} before={a.previous} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <CellLink
                      n={a.firstReplyH == null ? 0 : 1}
                      onClick={() => show(a, "firstReply", "first replies", "Answered tickets from the last 28 days, slowest first.")}
                    >
                      {fmtHours(a.firstReplyH)}
                    </CellLink>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <CellLink
                      n={a.reopenRate ? 1 : 0}
                      onClick={() => show(a, "reopened", "reopens", "Answered tickets from the last 28 days, reopened ones first.")}
                    >
                      {pct(a.reopenRate)}
                    </CellLink>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <CellLink n={a.open} onClick={() => show(a, "open", "open now", "Every open ticket for this app, whoever's turn it is.")}>
                      {a.open}
                    </CellLink>
                    {a.owesReply ? (
                      <span className="text-tone-bad">
                        {" · "}
                        <CellLink
                          n={a.owesReply}
                          onClick={() => show(a, "owesReply", "waiting on us", "Open tickets where the customer wrote the newest message.")}
                        >
                          {a.owesReply}
                        </CellLink>
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <CellLink n={a.bugs} onClick={() => show(a, "bugs", "real bugs", "Handoffs in the last 28 days the review judged a real product bug.")}>
                      {a.bugs || "—"}
                    </CellLink>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <CellLink n={a.gaps} onClick={() => show(a, "gaps", "knowledge gaps", "Handoffs in the last 28 days that only needed an answer Jetta didn't have.")}>
                      {a.gaps || "—"}
                    </CellLink>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <EmptyState title="No tickets in the last 28 days" />
        )}
      </CardContent>
    </Card>
  );
}
