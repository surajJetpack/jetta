/** The wizard's last stop: manual cleanup steps plus the scan-then-clean auto-cleanup. */
"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Check,
  Circle,
  CircleCheck,
  Loader2,
  RotateCw,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { SectionHeader } from "@/components/jetta/page-header";
import { PLAYBOOK_CLEANUP, type PlaybookProgress } from "@/lib/test-playbook";

interface CleanupScanResult {
  tickets: { id: string; subject: string; status: string; url: string }[];
  chats: { id: string; visitor: string; status: string }[];
  monday: { id: string; name: string; url: string }[];
  notes: string[];
}
interface CleanupRunResult {
  tickets: { id: string; subject: string; ok: boolean }[];
  chats: { id: string; ok: boolean }[];
  monday: { id: string; name: string; ok: boolean; reason?: string }[];
  notes: string[];
}

export function CleanupView({
  mine,
  done,
  total,
  onCheck,
  onTickAll,
}: {
  mine: PlaybookProgress;
  done: number;
  total: number;
  onCheck: (checkId: string) => void;
  onTickAll: (ids: string[]) => void;
}) {
  const ticked = mine["cleanup"]?.checks ?? [];
  return (
    <div className="space-y-4">
      {done === total && total > 0 && (
        <Alert>
          <CircleCheck className="size-4" />
          <AlertTitle>Every scenario has an outcome</AlertTitle>
          <AlertDescription>
            One last thing: the tests touched real systems on purpose. Run the auto-cleanup below,
            then tick off whatever it couldn&apos;t reach.
          </AlertDescription>
        </Alert>
      )}

      <AutoCleanup onTickAll={onTickAll} />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">The checklist — leave no trace</CardTitle>
          <p className="text-sm text-muted-foreground">
            Auto-cleanup ticks the first three when it finds nothing left. The Slack one is always
            yours: only you know which thread your bug report escalated to.
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          {PLAYBOOK_CLEANUP.map((c) => (
            <div key={c.id} className="flex items-start gap-2">
              <Checkbox
                id={`cleanup-${c.id}`}
                className="mt-0.5"
                checked={ticked.includes(c.id)}
                onCheckedChange={() => onCheck(c.id)}
              />
              <Label htmlFor={`cleanup-${c.id}`} className="cursor-pointer leading-snug font-normal">
                {c.text}
              </Label>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function AutoCleanup({ onTickAll }: { onTickAll: (ids: string[]) => void }) {
  const [phase, setPhase] = useState<"idle" | "scanning" | "scanned" | "cleaning" | "done">("idle");
  const [scan, setScan] = useState<CleanupScanResult | null>(null);
  const [report, setReport] = useState<CleanupRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const doScan = async () => {
    setPhase("scanning");
    setError(null);
    setReport(null);
    try {
      const res = await fetch("/api/playbook/cleanup");
      if (!res.ok) throw new Error(`scan failed (${res.status})`);
      setScan((await res.json()) as CleanupScanResult);
      setPhase("scanned");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    }
  };

  const doClean = async () => {
    setPhase("cleaning");
    setError(null);
    try {
      const res = await fetch("/api/playbook/cleanup", { method: "POST" });
      if (!res.ok) throw new Error(`cleanup failed (${res.status})`);
      const r = (await res.json()) as CleanupRunResult;
      setReport(r);
      setPhase("done");
      // Tick only the boxes whose whole category actually came clean.
      const ids: string[] = [];
      if (r.tickets.every((t) => t.ok)) ids.push("cu-tickets");
      if (r.chats.every((c) => c.ok)) ids.push("cu-chats");
      if (r.monday.every((m) => m.ok)) ids.push("cu-monday");
      if (ids.length) onTickAll(ids);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("scanned");
    }
  };

  const found = scan ? scan.tickets.length + scan.chats.length + scan.monday.length : 0;

  return (
    <Card className="border-primary/30">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="size-4 text-primary" /> Auto-cleanup
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Scans for what the tests left behind — open [TEST] tickets, your demo chats, [TEST]
          dev-board items — shows you the list, and only cleans when you say so.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {(phase === "idle" || phase === "scanning") && (
          <Button onClick={doScan} disabled={phase === "scanning"}>
            {phase === "scanning" ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />}
            {phase === "scanning" ? "Scanning…" : "Scan for leftovers"}
          </Button>
        )}

        {phase !== "idle" && phase !== "scanning" && scan && !report && (
          <>
            {found === 0 ? (
              <Alert>
                <CircleCheck className="size-4" />
                <AlertTitle>Nothing left behind</AlertTitle>
                <AlertDescription>
                  No open [TEST] tickets, no unresolved demo chats, no [TEST] board items. Run the
                  scan again after your last scenario if you keep testing.
                </AlertDescription>
              </Alert>
            ) : (
              <ScanList scan={scan} />
            )}
            {scan.notes.map((n, i) => (
              <p key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <TriangleAlert className="mt-px size-3.5 shrink-0 text-tone-warn" aria-hidden />
                {n}
              </p>
            ))}
            <div className="flex flex-wrap items-center gap-2">
              {found > 0 && (
                <Button onClick={doClean} disabled={phase === "cleaning"}>
                  {phase === "cleaning" ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                  {phase === "cleaning" ? "Cleaning up…" : `Clean up ${found} item${found === 1 ? "" : "s"}`}
                </Button>
              )}
              {found === 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onTickAll(["cu-tickets", "cu-chats", "cu-monday"])}
                >
                  <Check className="size-4" /> Tick the boxes for me
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={doScan} disabled={phase === "cleaning"}>
                <RotateCw /> Rescan
              </Button>
            </div>
          </>
        )}

        {phase === "done" && report && (
          <>
            <Alert>
              <CircleCheck className="size-4" />
              <AlertTitle>Cleanup done</AlertTitle>
              <AlertDescription>
                <ul className="mt-1 space-y-0.5 text-sm">
                  <li>
                    {report.tickets.filter((t) => t.ok).length}/{report.tickets.length} [TEST]
                    tickets closed
                  </li>
                  <li>
                    {report.chats.filter((c) => c.ok).length}/{report.chats.length} test chats
                    resolved
                  </li>
                  <li>
                    {report.monday.filter((m) => m.ok).length}/{report.monday.length} [TEST] board
                    items deleted
                  </li>
                </ul>
              </AlertDescription>
            </Alert>
            {report.notes.map((n, i) => (
              <p key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <TriangleAlert className="mt-px size-3.5 shrink-0 text-tone-warn" aria-hidden />
                {n}
              </p>
            ))}
            <Button variant="ghost" size="sm" onClick={doScan}>
              <RotateCw /> Scan again
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ScanList({ scan }: { scan: CleanupScanResult }) {
  return (
    <div className="space-y-2 text-sm">
      {scan.tickets.length > 0 && (
        <div>
          <SectionHeader>Tickets to close</SectionHeader>
          <ul className="mt-1 space-y-0.5">
            {scan.tickets.map((t) => (
              <li key={t.id} className="flex items-center gap-2">
                <Circle className="size-2 shrink-0 fill-current text-muted-foreground/50" />
                <a
                  href={t.url}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate font-medium underline underline-offset-2"
                >
                  #{t.id} {t.subject}
                </a>
                <span className="shrink-0 text-xs text-muted-foreground">{t.status}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {scan.chats.length > 0 && (
        <div>
          <SectionHeader>Chats to resolve</SectionHeader>
          <ul className="mt-1 space-y-0.5">
            {scan.chats.map((c) => (
              <li key={c.id} className="flex items-center gap-2">
                <Circle className="size-2 shrink-0 fill-current text-muted-foreground/50" />
                <Link href={`/chats/${c.id}`} target="_blank" className="truncate font-medium underline underline-offset-2">
                  {c.visitor}
                </Link>
                <span className="shrink-0 text-xs text-muted-foreground">{c.status}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {scan.monday.length > 0 && (
        <div>
          <SectionHeader>Dev-board items to delete</SectionHeader>
          <ul className="mt-1 space-y-0.5">
            {scan.monday.map((m) => (
              <li key={m.id} className="flex items-center gap-2">
                <Circle className="size-2 shrink-0 fill-current text-muted-foreground/50" />
                <a
                  href={m.url}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate font-medium underline underline-offset-2"
                >
                  {m.name}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
