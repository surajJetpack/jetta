"use client";

import { useEffect, useState } from "react";
import { Loader2, Lock, Radio, TriangleAlert } from "lucide-react";
import { fmtDuration } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Alert, AlertTitle } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StepCard, TraceIO } from "@/components/jetta/step-card";
import { EmptyState } from "@/components/jetta/empty-state";

interface TraceEntry {
  tool: string;
  input: unknown;
  result: string;
}
interface RunResult {
  ticket?: { id: string; subject: string; status: string; requester: string | null; product: string };
  model?: string;
  dryRun?: boolean;
  blockedByAllowlist?: boolean;
  durationMs?: number;
  resolutionSent?: boolean;
  reply?: string;
  trace?: TraceEntry[];
  error?: string;
  message?: string;
}

/**
 * The tabs are separate routes, so navigating away unmounts this component and
 * drops its React state. We persist the last run so it is restored on return:
 *   - a module-scoped `cache` covers client-side tab navigation, and
 *   - `sessionStorage` additionally covers a full page reload / cold module.
 * Both are client-only, so nothing leaks between SSR requests.
 */
type Channel = "freshdesk" | "freshchat";
type RunState = { ticketId: string; dryRun: boolean; channel?: Channel; res: RunResult | null };
const STORAGE_KEY = "jetta:lastRun";
let cache: RunState | null = null;

function readStorage(): RunState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as RunState) : null;
  } catch {
    return null;
  }
}

export default function TicketTester({
  freshdeskLive,
  freshchatLive,
}: {
  freshdeskLive: boolean;
  freshchatLive: boolean;
}) {
  // Initialise from defaults so the first client render matches the server (no
  // hydration mismatch); persisted state is loaded in the mount effect below.
  const [ticketId, setTicketId] = useState(() => cache?.ticketId ?? "");
  const [dryRun, setDryRun] = useState(() => cache?.dryRun ?? true);
  const [channel, setChannel] = useState<Channel>(() => cache?.channel ?? "freshdesk");
  const [loading, setLoading] = useState(false);
  const [res, setRes] = useState<RunResult | null>(() => cache?.res ?? null);

  // On mount, if the in-memory cache was empty (e.g. after a full page reload
  // that re-evaluated this module), rehydrate from sessionStorage.
  useEffect(() => {
    if (cache) return;
    const saved = readStorage();
    if (!saved) return;
    cache = saved;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time rehydration from storage on mount
    setTicketId(saved.ticketId ?? "");
    setDryRun(saved.dryRun ?? true);
    setChannel(saved.channel ?? "freshdesk");
    setRes(saved.res ?? null);
  }, []);

  // Persist the current run to both the module cache (survives tab navigation)
  // and sessionStorage (survives a reload).
  useEffect(() => {
    cache = { ticketId, dryRun, channel, res };
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
      } catch {
        /* storage full or unavailable — module cache still covers tab nav */
      }
    }
  }, [ticketId, dryRun, channel, res]);

  async function run() {
    if (!ticketId.trim()) return;
    setLoading(true);
    setRes(null);
    try {
      const r = await fetch("/api/admin/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketId: ticketId.trim(), dryRun, channel }),
      });
      setRes((await r.json()) as RunResult);
    } catch (e) {
      setRes({ error: "request failed", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  }

  const willPost = !dryRun && (channel === "freshchat" ? freshchatLive : freshdeskLive);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Run a ticket through Jetta</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={channel} onValueChange={(v) => setChannel(v as Channel)}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="freshdesk">Freshdesk</SelectItem>
              <SelectItem value="freshchat">Freshchat</SelectItem>
            </SelectContent>
          </Select>
          <Input
            type="text"
            className="w-64 flex-1 sm:flex-none"
            placeholder={channel === "freshchat" ? "Freshchat conversation ID" : "Freshdesk ticket ID (e.g. 13599)"}
            value={ticketId}
            onChange={(e) => setTicketId(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run()}
          />
          <Label className="flex cursor-pointer items-center gap-1.5 text-sm font-normal text-muted-foreground">
            <Checkbox checked={dryRun} onCheckedChange={(v) => setDryRun(v === true)} />
            Dry run (preview, no posting)
          </Label>
          <Button onClick={run} disabled={loading || !ticketId.trim()}>
            {loading && <Loader2 className="animate-spin" />}
            {loading ? "Running…" : "Run"}
          </Button>
        </div>

        {willPost && (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>
              Dry run is OFF and {channel === "freshchat" ? "Freshchat" : "Freshdesk"} is live — running will post a
              real reply to the {channel === "freshchat" ? "conversation" : "ticket"}.
            </AlertTitle>
          </Alert>
        )}

        {res &&
          (res.error ? (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertTitle>
                {res.error}
                {res.message ? `: ${res.message}` : ""}
              </AlertTitle>
            </Alert>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                <span className="text-foreground">
                  <b>#{res.ticket?.id}</b> {res.ticket?.subject}
                </span>
                <span>
                  product <b className="text-foreground">{res.ticket?.product}</b>
                </span>
                <span>
                  model <b className="text-foreground">{res.model}</b>
                </span>
                <span className="inline-flex items-center gap-1">
                  {res.dryRun ? <Lock className="size-3.5" /> : <Radio className="size-3.5 text-[var(--live)]" />}
                  {res.dryRun ? "dry run" : "live"}
                </span>
                {res.blockedByAllowlist && (
                  <span className="text-[var(--stub)]">not on allowlist → forced dry-run</span>
                )}
                {res.resolutionSent && (
                  <span>
                    <b className="text-foreground">resolution sent</b> → follow-up scheduled
                  </span>
                )}
                <span>{fmtDuration(res.durationMs)}</span>
              </div>

              {res.reply && (
                <div>
                  <div className="mb-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                    Final reply
                  </div>
                  <div className="rounded-lg border bg-muted/40 p-3 text-sm whitespace-pre-wrap">{res.reply}</div>
                </div>
              )}

              <div>
                <div className="mb-1.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                  Tool trace ({res.trace?.length ?? 0} call{res.trace?.length === 1 ? "" : "s"})
                </div>
                {res.trace?.length ? (
                  <div className="space-y-2">
                    {res.trace.map((t, i) => (
                      <StepCard key={i} title={`${i + 1}. ${t.tool}`}>
                        <TraceIO>→ {JSON.stringify(t.input)}</TraceIO>
                        <TraceIO className="whitespace-pre-wrap">{t.result}</TraceIO>
                      </StepCard>
                    ))}
                  </div>
                ) : (
                  <EmptyState title="No tools were called" />
                )}
              </div>
            </div>
          ))}
      </CardContent>
    </Card>
  );
}
