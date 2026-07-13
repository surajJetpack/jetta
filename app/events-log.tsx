"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, Info, OctagonX, RotateCw, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { StepCard, TraceIO } from "@/components/jetta/step-card";
import { ChipButton, type ChipTone } from "@/components/jetta/status-chip";
import { EmptyState } from "@/components/jetta/empty-state";
import { RelativeTime } from "@/components/jetta/relative-time";

interface OpsEvent {
  id: string;
  at: number; // unix ms
  level: "info" | "warn" | "error";
  event: string;
  source: string;
  ticketId?: string;
  actor?: string;
  data?: Record<string, unknown>;
}

const LEVEL_TONE: Record<OpsEvent["level"], ChipTone> = { info: "published", warn: "draft", error: "stale" };
const SOURCES = ["webhook", "freshchat", "console", "cron", "slack", "auth", "app"];

function LevelIcon({ level }: { level: OpsEvent["level"] }) {
  if (level === "error") return <OctagonX className="size-4 shrink-0 text-destructive" aria-hidden />;
  if (level === "warn") return <TriangleAlert className="size-4 shrink-0 text-[var(--stub)]" aria-hidden />;
  return <Info className="size-4 shrink-0 text-muted-foreground" aria-hidden />;
}

export default function EventsLog() {
  const [events, setEvents] = useState<OpsEvent[] | null>(null);
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState<string>("");
  const [source, setSource] = useState<string>("");
  const [prefix, setPrefix] = useState("");

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: "300" });
    if (level) params.set("level", level);
    if (source) params.set("source", source);
    if (prefix.trim()) params.set("event", prefix.trim());
    const r = await fetch(`/api/admin/events?${params}`, { cache: "no-store" }).then((x) => x.json());
    setEvents(r.events ?? []);
  }, [level, source, prefix]);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch; state set after await, not synchronously
    load();
  }, [open, load]);

  return (
    <Card>
      <CardHeader>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="cursor-pointer text-left focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <CardTitle>
            Event log {events ? `(${events.length})` : ""} {open ? "▾" : "▸"}
          </CardTitle>
        </button>
      </CardHeader>
      {open && (
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Every system event — webhook receipts and skips, runs, draft decisions, learnings, logins, cron and Slack
            activity — durable and machine-readable.
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {["", "info", "warn", "error"].map((l) => (
              <ChipButton
                key={l || "all"}
                tone={l ? LEVEL_TONE[l as OpsEvent["level"]] : "archived"}
                pressed={level === l}
                onPressedChange={() => setLevel(l)}
              >
                {l || "all levels"}
              </ChipButton>
            ))}
            <Separator orientation="vertical" className="mx-1 !h-4" />
            {["", ...SOURCES].map((s) => (
              <ChipButton key={s || "all"} tone="archived" pressed={source === s} onPressedChange={() => setSource(s)}>
                {s || "all sources"}
              </ChipButton>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="text"
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && load()}
              placeholder="event prefix, e.g. webhook."
              className="w-56"
            />
            <Button variant="ghost" size="sm" onClick={load}>
              <RotateCw /> Refresh
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href="/api/admin/events?format=ndjson&limit=1000">
                <Download /> Download NDJSON
              </a>
            </Button>
          </div>

          {events === null && (
            <div className="space-y-2">
              <Skeleton className="h-11 w-full" />
              <Skeleton className="h-11 w-full" />
              <Skeleton className="h-11 w-2/3" />
            </div>
          )}
          {events !== null && events.length === 0 && (
            <EmptyState title="No events match" hint="Adjust the level, source, or prefix filters and refresh." />
          )}
          {events?.map((e) => (
            <StepCard
              key={e.id}
              collapsible
              defaultOpen={false}
              title={
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <LevelIcon level={e.level} />
                  <span className="truncate">{e.event}</span>
                  {e.ticketId && <span className="shrink-0 font-normal text-muted-foreground">#{e.ticketId}</span>}
                </span>
              }
              meta={
                <>
                  {e.source}
                  {e.actor ? ` · ${e.actor}` : ""} · <RelativeTime at={Math.floor(e.at / 1000)} />
                </>
              }
            >
              <TraceIO>
                <pre className="whitespace-pre-wrap">{JSON.stringify(e, null, 2)}</pre>
              </TraceIO>
            </StepCard>
          ))}
        </CardContent>
      )}
    </Card>
  );
}
