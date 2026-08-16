"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { diffWords } from "diff";
import { Check, ChevronDown, ChevronRight, FileText, Pencil, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StepCard, TraceIO } from "@/components/jetta/step-card";
import { StatusChip } from "@/components/jetta/status-chip";
import { ConfirmButton } from "@/components/jetta/confirm-button";
import { EmptyState } from "@/components/jetta/empty-state";
import { Md } from "./markdown";
import type { Article } from "./kb-list";

interface Hit { id: string; title: string; url: string; body: string; source: string; score?: number }

/** Word-level diff: draft body vs the nearest existing article's body. */
function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const parts = useMemo(() => diffWords(oldText, newText), [oldText, newText]);
  return (
    <div className="diff">
      {parts.map((p, i) => (
        <span key={i} className={p.added ? "add" : p.removed ? "del" : undefined}>
          {p.value}
        </span>
      ))}
    </div>
  );
}

function DraftCard({ draft, onDecide }: { draft: Article; onDecide: () => void }) {
  const [open, setOpen] = useState(false);
  const [similar, setSimilar] = useState<Hit | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [busy, setBusy] = useState(false);

  // On expand, find the nearest existing article so the reviewer sees overlap.
  useEffect(() => {
    if (!open || similar) return;
    (async () => {
      const r = await fetch(`/api/admin/kb/search?q=${encodeURIComponent(draft.title)}&rerank=0`, { cache: "no-store" })
        .then((x) => x.json())
        .catch(() => null);
      const hit = (r?.hits ?? []).find((h: Hit) => h.id !== draft.id);
      setSimilar(hit ?? null);
    })();
  }, [open, similar, draft.id, draft.title]);

  async function decide(action: "approve" | "reject") {
    setBusy(true);
    await fetch("/api/admin/kb/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: draft.id, action }),
    });
    setBusy(false);
    onDecide();
  }

  const dup = draft.duplicates?.[0];

  return (
    <StepCard
      title={
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm text-left focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {open ? <ChevronDown className="text-muted-foreground" /> : <ChevronRight className="text-muted-foreground" />}
          <FileText />
          <span className="truncate">{draft.title}</span>
        </button>
      }
      meta={
        <>
          {draft.origin} · {draft.createdBy}
          {dup && <StatusChip tone="stale">dup? {dup.title.slice(0, 40)}</StatusChip>}
        </>
      }
    >
      {!open ? (
        <TraceIO>{draft.body.slice(0, 200)}…</TraceIO>
      ) : (
        <>
          <div className="rounded-lg border bg-background px-3 py-1">
            <Md>{draft.body}</Md>
          </div>
          {draft.keywords.length > 0 && <TraceIO>keywords: {draft.keywords.join(", ")}</TraceIO>}

          {similar && (
            <div className="text-xs text-muted-foreground">
              Closest existing article:{" "}
              <Link href={`/kb/article?id=${encodeURIComponent(similar.id)}`} className="text-primary hover:underline">
                {similar.title}
              </Link>
              {similar.score !== undefined && ` (${similar.score.toFixed(3)})`}
              <Button variant="link" size="sm" onClick={() => setShowDiff(!showDiff)}>
                {showDiff ? "hide diff" : "show diff"}
              </Button>
              {showDiff && <DiffView oldText={similar.body} newText={draft.body} />}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={busy} onClick={() => decide("approve")}>
              <Check /> Approve → publish
            </Button>
            <Button variant="secondary" asChild>
              <Link href={`/kb/article?id=${encodeURIComponent(draft.id)}`}>
                <Pencil /> Edit first
              </Link>
            </Button>
            <ConfirmButton
              variant="destructive"
              title="Reject and delete this draft?"
              description="The draft is removed permanently."
              confirmLabel="Reject"
              onConfirm={() => decide("reject")}
              disabled={busy}
            >
              <Trash2 /> Reject
            </ConfirmButton>
          </div>
        </>
      )}
    </StepCard>
  );
}

export default function KbReview() {
  const [drafts, setDrafts] = useState<Article[] | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/admin/kb/drafts", { cache: "no-store" }).then((x) => x.json());
    setDrafts(r.drafts ?? []);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch; state set after await, not synchronously
    load();
  }, [load]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Review queue {drafts ? `(${drafts.length})` : ""}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2.5">
        <p className="text-sm text-muted-foreground">
          Drafts from the Knowledge Loop (Slack escalations) and Freshdesk mining. Nothing reaches the
          agent until a human approves it — approving publishes the article and embeds it for retrieval.
        </p>
        {drafts === null && (
          <div className="space-y-2.5">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-2/3" />
          </div>
        )}
        {drafts?.map((d) => <DraftCard key={d.id} draft={d} onDecide={load} />)}
        {drafts?.length === 0 && (
          <EmptyState title="Queue is empty" hint="New drafts from the Knowledge Loop and Freshdesk mining land here." />
        )}
      </CardContent>
    </Card>
  );
}
