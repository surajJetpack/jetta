"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Archive,
  Check,
  ExternalLink,
  FlaskConical,
  Loader2,
  PencilLine,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { StepCard } from "@/components/jetta/step-card";
import { StatusChip } from "@/components/jetta/status-chip";
import { ConfirmButton } from "@/components/jetta/confirm-button";
import { EmptyState } from "@/components/jetta/empty-state";
import { RelativeTime } from "@/components/jetta/relative-time";

interface ReplyEvaluation {
  id: string;
  ticketId: string;
  subject?: string;
  channel: "freshdesk" | "freshchat";
  product: string;
  model?: string;
  decidedBy: string;
  at: number;
  action: "approve" | "discard";
  rating: "good" | "partial" | "bad";
  tags: string[];
  note?: string;
  suggestedReply: string;
  finalBody?: string;
  distilled?: boolean;
  learningIds?: string[];
}

interface EvalStats {
  windowDays: number;
  total: number;
  byRating: { good: number; partial: number; bad: number };
  editRate: number;
  discardRate: number;
  tagCounts: Record<string, number>;
  byProduct: Record<string, { good: number; partial: number; bad: number }>;
}

interface Learning {
  id: string;
  text: string;
  category: string;
  product: "getsign" | "jetpackapps" | "all";
  state: "candidate" | "approved" | "rejected" | "retired";
  createdAt: number;
  updatedAt: number;
  decidedBy?: string;
  sourceEvalIds: string[];
  reinforcedCount: number;
  supersedes?: string;
  rationale?: string;
}

function RatingIcon({ rating }: { rating: ReplyEvaluation["rating"] }) {
  if (rating === "good") return <ThumbsUp className="size-4 text-[var(--live)]" />;
  if (rating === "partial") return <PencilLine className="size-4 text-[var(--stub)]" />;
  return <ThumbsDown className="size-4 text-destructive" />;
}

function CandidateCard({ learning, onDecide }: { learning: Learning; onDecide: () => void }) {
  const [text, setText] = useState(learning.text);
  const [busy, setBusy] = useState(false);

  async function decide(action: "approve" | "reject") {
    setBusy(true);
    const r = await fetch("/api/admin/learnings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: learning.id, action, ...(action === "approve" ? { text } : {}) }),
    });
    setBusy(false);
    if (r.status === 409) toast.warning("This learning was already decided — refreshing.");
    else if (!r.ok) {
      const j = (await r.json().catch(() => null)) as { error?: string } | null;
      toast.error(`Failed: ${j?.error ?? r.statusText}`);
    } else {
      toast.success(action === "approve" ? "Learning approved — live in the next reply" : "Learning rejected");
    }
    onDecide();
  }

  return (
    <StepCard
      title={
        <span className="inline-flex items-center gap-1.5">
          <Sparkles /> Candidate learning
        </span>
      }
      meta={
        <>
          <StatusChip tone="draft">{learning.category}</StatusChip>
          <StatusChip tone="in_review">{learning.product}</StatusChip>
          {learning.supersedes && <StatusChip tone="stale">revises an approved learning</StatusChip>}
          <span>
            from {learning.sourceEvalIds.length} evaluation{learning.sourceEvalIds.length === 1 ? "" : "s"}
          </span>
        </>
      }
    >
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        maxLength={300}
        className="bg-background text-sm"
      />
      {learning.rationale && <p className="text-xs text-muted-foreground">Why: {learning.rationale}</p>}
      <div className="flex items-center gap-2">
        <Button disabled={busy || !text.trim()} onClick={() => decide("approve")}>
          <Check /> {busy ? "Working…" : `Approve${text.trim() !== learning.text ? " (edited)" : ""}`}
        </Button>
        <Button variant="destructive" disabled={busy} onClick={() => decide("reject")}>
          <X /> Reject
        </Button>
      </div>
    </StepCard>
  );
}

export default function EvalsPanel({ freshdeskDomain }: { freshdeskDomain: string }) {
  const [evals, setEvals] = useState<ReplyEvaluation[] | null>(null);
  const [stats, setStats] = useState<EvalStats | null>(null);
  const [learnings, setLearnings] = useState<Learning[] | null>(null);
  const [distilling, setDistilling] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(async () => {
    const [e, l] = await Promise.all([
      fetch("/api/admin/evals", { cache: "no-store" }).then((x) => x.json()),
      fetch("/api/admin/learnings", { cache: "no-store" }).then((x) => x.json()),
    ]);
    setEvals(e.evaluations ?? []);
    setStats(e.stats ?? null);
    setLearnings(l.learnings ?? []);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch; state set after await, not synchronously
    load();
  }, [load]);

  async function retire(id: string) {
    const r = await fetch("/api/admin/learnings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action: "retire" }),
    });
    if (!r.ok) {
      const j = (await r.json().catch(() => null)) as { error?: string } | null;
      toast.error(`Failed: ${j?.error ?? r.statusText}`);
    } else {
      toast.success("Learning retired — no longer injected.");
    }
    load();
  }

  async function distillNow() {
    setDistilling(true);
    const r = await fetch("/api/admin/evals/distill", { method: "POST" });
    const j = (await r.json().catch(() => null)) as
      | { created?: number; reinforced?: number; revised?: number; consumed?: number; error?: string }
      | null;
    setDistilling(false);
    if (!r.ok) toast.error(`Distill failed: ${j?.error ?? r.statusText}`);
    else
      toast.success(
        `Distilled ${j?.consumed ?? 0} evaluations → ${j?.created ?? 0} new, ${j?.reinforced ?? 0} reinforced, ${j?.revised ?? 0} revisions.`,
      );
    load();
  }

  const candidates = learnings?.filter((l) => l.state === "candidate") ?? [];
  const approved = learnings?.filter((l) => l.state === "approved") ?? [];
  const undistilled = evals?.filter((e) => !e.distilled).length ?? 0;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Draft quality {stats ? `(last ${stats.windowDays} days)` : ""}</CardTitle>
        </CardHeader>
        <CardContent>
          {stats === null && <Skeleton className="h-10 w-full" />}
          {stats && (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div className="rounded-lg border bg-muted/40 p-3">
                <div className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Decisions</div>
                <div className="mt-1 font-mono text-lg font-semibold">{stats.total}</div>
              </div>
              <div className="rounded-lg border bg-muted/40 p-3">
                <div className="flex items-center gap-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                  <ThumbsUp className="size-3" /> Sent as-is
                </div>
                <div className="mt-1 font-mono text-lg font-semibold">{stats.byRating.good}</div>
              </div>
              <div className="rounded-lg border bg-muted/40 p-3">
                <div className="flex items-center gap-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                  <PencilLine className="size-3" /> Edited
                </div>
                <div className="mt-1 font-mono text-lg font-semibold">
                  {stats.byRating.partial}
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    ({Math.round(stats.editRate * 100)}%)
                  </span>
                </div>
              </div>
              <div className="rounded-lg border bg-muted/40 p-3">
                <div className="flex items-center gap-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                  <ThumbsDown className="size-3" /> Discarded
                </div>
                <div className="mt-1 font-mono text-lg font-semibold">
                  {stats.byRating.bad}
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    ({Math.round(stats.discardRate * 100)}%)
                  </span>
                </div>
              </div>
            </div>
          )}
          {stats && Object.keys(stats.tagCounts).length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {Object.entries(stats.tagCounts)
                .sort((a, b) => b[1] - a[1])
                .map(([tag, n]) => (
                  <StatusChip key={tag} tone="draft">
                    {tag} ×{n}
                  </StatusChip>
                ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Candidate learnings {learnings ? `(${candidates.length})` : ""}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5">
          <p className="text-sm text-muted-foreground">
            Distilled from your feedback — nothing changes Jetta&apos;s behavior until you approve it here.
          </p>
          <div className="flex items-center gap-2">
            <Button variant="secondary" disabled={distilling || undistilled === 0} onClick={distillNow}>
              {distilling ? <Loader2 className="animate-spin" /> : <FlaskConical />}
              {distilling ? "Distilling…" : `Distill now (${undistilled} pending)`}
            </Button>
          </div>
          {learnings === null && <Skeleton className="h-20 w-full" />}
          {candidates.map((l) => (
            <CandidateCard key={l.id} learning={l} onDecide={load} />
          ))}
          {learnings !== null && candidates.length === 0 && (
            <EmptyState icon={Sparkles} title="No candidates waiting for review" hint="Distill accumulated feedback to generate new candidate rules." />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Approved learnings {learnings ? `(${approved.length})` : ""}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5">
          <p className="text-sm text-muted-foreground">
            Injected into every reply&apos;s system prompt (strongest first, capped at 20 per product).
          </p>
          {approved
            .sort((a, b) => b.reinforcedCount - a.reinforcedCount || b.updatedAt - a.updatedAt)
            .map((l) => (
              <StepCard
                key={l.id}
                title={<span className="font-normal text-foreground">{l.text}</span>}
                meta={
                  <ConfirmButton
                    title="Retire this learning?"
                    description="It stops being injected into new replies immediately. The record is kept and the distiller will not re-propose it."
                    confirmLabel="Retire"
                    variant="ghost"
                    size="xs"
                    onConfirm={() => retire(l.id)}
                  >
                    <Archive /> Retire
                  </ConfirmButton>
                }
              >
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <StatusChip tone="published">{l.product}</StatusChip>
                  <StatusChip tone="draft">{l.category}</StatusChip>
                  {l.reinforcedCount > 0 && <StatusChip tone="in_review">reinforced ×{l.reinforcedCount}</StatusChip>}
                  <span>
                    updated <RelativeTime at={l.updatedAt} />
                  </span>
                </div>
              </StepCard>
            ))}
          {learnings !== null && approved.length === 0 && <EmptyState title="No approved learnings yet" />}
        </CardContent>
      </Card>

      {evals !== null && evals.length > 0 && (
        <Card>
          <CardHeader>
            <button
              type="button"
              aria-expanded={showHistory}
              onClick={() => setShowHistory(!showHistory)}
              className="cursor-pointer text-left focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <CardTitle>
                Evaluation history ({evals.length}) {showHistory ? "▾" : "▸"}
              </CardTitle>
            </button>
          </CardHeader>
          {showHistory && (
            <CardContent className="space-y-2">
              {evals.slice(0, 50).map((e) => (
                <StepCard
                  key={e.id}
                  title={
                    <span className="inline-flex items-center gap-1.5">
                      <RatingIcon rating={e.rating} /> {e.subject ?? `Ticket #${e.ticketId}`}
                    </span>
                  }
                  meta={
                    <>
                      {e.product} · {e.decidedBy} · <RelativeTime at={e.at} />
                    </>
                  }
                >
                  <div className="flex flex-wrap items-center gap-1.5 text-sm">
                    <a
                      href={`https://${freshdeskDomain}/a/tickets/${e.ticketId}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      #{e.ticketId} <ExternalLink className="size-3.5" />
                    </a>
                    {e.tags.map((t) => (
                      <StatusChip key={t} tone="draft">
                        {t}
                      </StatusChip>
                    ))}
                    {e.rating === "partial" && <StatusChip tone="in_review">edited before send</StatusChip>}
                    {e.distilled && <StatusChip tone="published">distilled</StatusChip>}
                  </div>
                  {e.note && <p className="font-mono text-xs text-muted-foreground">{e.note}</p>}
                </StepCard>
              ))}
            </CardContent>
          )}
        </Card>
      )}
    </>
  );
}
