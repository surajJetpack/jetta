"use client";

/** "Right now" — where the ball is on every open ticket, and who is waiting on us. */
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/jetta/empty-state";
import { fmtHours } from "@/lib/format";
import { appName } from "@/lib/types";
import { cn } from "@/lib/utils";
import { TARGETS, type Backlog, type BacklogBucket } from "@/lib/support-health";
import type { Open } from "./health-shared";

/** One bar, four segments — where the ball is on every open ticket. */
function BallBar({ b, open }: { b: Backlog; open: Open }) {
  const parts: { key: BacklogBucket; label: string; n: number; cls: string; why: string }[] = [
    { key: "owes_reply", label: "Waiting on us", n: b.owesReply, cls: "bg-tone-bad", why: "the customer wrote the newest message" },
    { key: "engineering", label: "With engineering", n: b.engineering, cls: "bg-tone-warn", why: "status is Escalated to dev" },
    { key: "in_progress", label: "We're working on it", n: b.inProgress, cls: "bg-tone-info", why: "status is Working on it, Validating or Hold" },
    { key: "customer", label: "Waiting on the customer", n: b.customer, cls: "bg-muted-foreground/40", why: "we wrote the newest message" },
  ];
  const show = (p: (typeof parts)[number]) =>
    open({ title: p.label, description: `Open tickets where ${p.why}.`, drill: { kind: "bucket", bucket: p.key } });
  if (!b.open) return null;
  return (
    <div className="grid gap-2">
      <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full" role="img" aria-label={parts.map((p) => `${p.label}: ${p.n}`).join(", ")}>
        {parts.filter((p) => p.n).map((p) => (
          <button
            key={p.key}
            type="button"
            tabIndex={-1}
            aria-hidden
            onClick={() => show(p)}
            className={cn("h-full cursor-pointer first:rounded-l-full last:rounded-r-full hover:opacity-80", p.cls)}
            style={{ flexGrow: p.n }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
        {parts.map((p) => (
          <li key={p.key}>
            <button
              type="button"
              onClick={() => show(p)}
              disabled={!p.n}
              className="flex items-center gap-1.5 rounded-sm outline-none hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none"
            >
              <span className={cn("size-2 rounded-full", p.cls)} aria-hidden />
              {p.label} <span className="font-medium text-foreground tabular-nums">{p.n}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RightNow({ b, base, open }: { b: Backlog; base: string; open: Open }) {
  return (
    <Card id="right-now" className="scroll-mt-16 py-4">
      <CardHeader className="px-4">
        <CardTitle>Right now · {b.open} open</CardTitle>
        <CardDescription className="text-xs">
          Whose turn it is, read from the conversation itself: a customer is waiting on us when theirs is the newest
          message, whatever the ticket&apos;s status says.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 px-4">
        <BallBar b={b} open={open} />
        {b.waiting.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer waiting on us</TableHead>
                <TableHead>App</TableHead>
                <TableHead className="hidden sm:table-cell">Status in Freshdesk</TableHead>
                <TableHead className="text-right">Waiting</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {b.waiting.map((w) => (
                <TableRow key={w.ticketId}>
                  <TableCell className="max-w-[28rem] truncate">
                    <a href={`${base}${w.ticketId}`} target="_blank" rel="noreferrer" className="hover:underline">
                      <span className="text-muted-foreground tabular-nums">#{w.ticketId}</span> {w.subject}
                    </a>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{appName(w.app)}</TableCell>
                  <TableCell className="hidden whitespace-nowrap text-muted-foreground sm:table-cell">{w.status}</TableCell>
                  <TableCell
                    className={cn(
                      "text-right whitespace-nowrap tabular-nums",
                      w.waitingH > TARGETS.firstReplyH && "font-medium text-tone-bad",
                    )}
                  >
                    {fmtHours(w.waitingH)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <EmptyState title="No customer is waiting on a reply" />
        )}
        {b.owesReply > b.waiting.length && (
          <Button
            variant="link"
            size="sm"
            className="justify-self-start px-0"
            onClick={() =>
              open({
                title: "Customers waiting on us",
                description: "Open tickets where the customer wrote the newest message, longest wait first.",
                drill: { kind: "bucket", bucket: "owes_reply" },
              })
            }
          >
            Show all {b.owesReply}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
