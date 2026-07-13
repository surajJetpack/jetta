"use client";

import { useCallback, useState } from "react";
import { CheckCircle2, ExternalLink, Mail, RotateCcw, Trash2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { StepCard } from "@/components/jetta/step-card";
import { StatusChip, ChipButton } from "@/components/jetta/status-chip";
import { ConfirmButton } from "@/components/jetta/confirm-button";
import { EmptyState } from "@/components/jetta/empty-state";
import { RelativeTime } from "@/components/jetta/relative-time";
import { usePolling } from "@/lib/use-polling";

interface ReplyDraft {
  id: string;
  ticketId: string;
  subject?: string;
  channel: "freshdesk" | "freshchat";
  product: string;
  suggestedReply: string;
  wantsClose: boolean;
  resolutionSent: boolean;
  escalated: boolean;
  createdAt: number;
  state: "pending" | "approved" | "discarded" | "superseded";
  decidedAt?: number;
  decidedBy?: string;
  editedBody?: string;
  error?: string;
}

const EVAL_TAGS = [
  "product-knowledge-gap",
  "account-context",
  "authority",
  "judgment-call",
  "tone",
  "conciseness",
  "wrong-action",
  "policy",
  "other",
] as const;

function TagPicker({
  selected,
  onToggle,
  disabled,
}: {
  selected: string[];
  onToggle: (tag: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {EVAL_TAGS.map((t) => (
        <ChipButton
          key={t}
          tone="published"
          pressed={selected.includes(t)}
          onPressedChange={() => onToggle(t)}
          disabled={disabled}
        >
          {t}
        </ChipButton>
      ))}
    </div>
  );
}

function PendingCard({
  draft,
  freshdeskDomain,
  onDecide,
}: {
  draft: ReplyDraft;
  freshdeskDomain: string;
  onDecide: () => void;
}) {
  const [body, setBody] = useState(draft.suggestedReply);
  const [busy, setBusy] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const edited = body.trim() !== draft.suggestedReply;

  function toggleTag(tag: string) {
    setTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  }

  async function decide(action: "approve" | "discard") {
    setBusy(true);
    const r = await fetch("/api/admin/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: draft.id,
        action,
        ...(action === "approve" && edited ? { body } : {}),
        ...(tags.length ? { tags } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    });
    setBusy(false);
    if (r.status === 409) {
      toast.warning("This draft was already decided or superseded — refreshing.");
    } else if (!r.ok) {
      const j = (await r.json().catch(() => null)) as { error?: string } | null;
      toast.error(`Failed: ${j?.error ?? r.statusText}`);
    } else {
      toast.success(action === "approve" ? `Reply sent on #${draft.ticketId}` : "Draft discarded");
    }
    onDecide();
  }

  return (
    <StepCard
      collapsible
      defaultOpen={false}
      title={
        <span className="inline-flex items-center gap-1.5">
          <Mail /> {draft.subject ?? `Ticket #${draft.ticketId}`}
        </span>
      }
      meta={
        <>
          {draft.product} · {draft.channel} · <RelativeTime at={draft.createdAt} />
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <a
          href={`https://${freshdeskDomain}/a/tickets/${draft.ticketId}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
        >
          #{draft.ticketId} <ExternalLink className="size-3.5" />
        </a>
        {draft.wantsClose && <StatusChip tone="stale">will resolve ticket</StatusChip>}
        {draft.resolutionSent && <StatusChip tone="published">schedules 24h follow-up</StatusChip>}
        {draft.escalated && <StatusChip tone="draft">escalated to dev team</StatusChip>}
        {draft.error && <StatusChip tone="stale">last send failed: {draft.error.slice(0, 60)}</StatusChip>}
      </div>

      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={Math.min(18, Math.max(6, body.split("\n").length + 2))}
        className="bg-background text-sm"
      />

      {!discarding ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <ConfirmButton
              title={`Send reply on ticket #${draft.ticketId}?`}
              description={
                `The customer receives this reply immediately${edited ? " (with your edits)" : ""}.` +
                (draft.wantsClose ? "\nThe ticket will also be marked resolved." : "")
              }
              confirmLabel="Send reply"
              onConfirm={() => decide("approve")}
              disabled={busy || !body.trim()}
              busy={busy}
            >
              <CheckCircle2 /> {busy ? "Working…" : `Approve & send${edited ? " (edited)" : ""}`}
            </ConfirmButton>
            <Button variant="destructive" size="default" disabled={busy} onClick={() => setDiscarding(true)}>
              <Trash2 /> Discard…
            </Button>
            {edited && (
              <Button variant="ghost" size="sm" onClick={() => setBody(draft.suggestedReply)}>
                <RotateCcw /> Reset edits
              </Button>
            )}
            <Button
              variant="link"
              size="sm"
              className="text-muted-foreground"
              onClick={() => setFeedbackOpen(!feedbackOpen)}
            >
              {feedbackOpen ? "Hide feedback" : "Add feedback"}
            </Button>
          </div>
          {feedbackOpen && (
            <div className="grid gap-2">
              <TagPicker selected={tags} onToggle={toggleTag} disabled={busy} />
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Optional note for the learning loop (why was this edited / what to do differently)"
                className="bg-background text-xs"
              />
            </div>
          )}
        </>
      ) : (
        <div className="grid gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
          <p className="text-sm text-muted-foreground">
            Why is this draft being discarded? Pick at least one reason — it teaches Jetta.
          </p>
          <TagPicker selected={tags} onToggle={toggleTag} disabled={busy} />
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note (what should the reply have done instead?)"
            className="bg-background text-xs"
          />
          <div className="flex items-center gap-2">
            <Button variant="destructive" disabled={busy || tags.length === 0} onClick={() => decide("discard")}>
              <Trash2 /> {busy ? "Working…" : "Confirm discard"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setDiscarding(false)}>
              <Undo2 /> Cancel
            </Button>
          </div>
        </div>
      )}
    </StepCard>
  );
}

export default function DraftsQueue({
  replyMode,
  freshdeskDomain,
}: {
  replyMode: "auto" | "draft";
  freshdeskDomain: string;
}) {
  const [drafts, setDrafts] = useState<ReplyDraft[] | null>(null);
  const [showDecided, setShowDecided] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/admin/drafts", { cache: "no-store" }).then((x) => x.json());
    setDrafts(r.drafts ?? []);
  }, []);
  // Reviewers keep this tab open — refresh once a minute while it's visible.
  usePolling(load, 60_000);

  const pending = drafts?.filter((d) => d.state === "pending") ?? [];
  const decided = drafts?.filter((d) => d.state !== "pending") ?? [];

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Reply drafts {drafts ? `(${pending.length} pending)` : ""}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5">
          <p className="text-sm text-muted-foreground">
            Jetta proposes, you approve. Every webhook ticket gets a suggested reply here — nothing reaches the
            customer until it&apos;s approved.
          </p>
          {replyMode === "auto" && (
            <Alert variant="destructive">
              <AlertTitle>Reply mode is currently AUTO — new webhook runs reply directly and won&apos;t land here.</AlertTitle>
            </Alert>
          )}
          {drafts === null && (
            <div className="space-y-2.5">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-2/3" />
            </div>
          )}
          {pending.map((d) => (
            <PendingCard key={d.id} draft={d} freshdeskDomain={freshdeskDomain} onDecide={load} />
          ))}
          {drafts !== null && pending.length === 0 && (
            <EmptyState title="Queue is empty" hint="New drafts appear here automatically — this page refreshes every minute." />
          )}
        </CardContent>
      </Card>

      {decided.length > 0 && (
        <Card>
          <CardHeader>
            <button
              type="button"
              aria-expanded={showDecided}
              onClick={() => setShowDecided(!showDecided)}
              className="cursor-pointer text-left focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <CardTitle>
                Recently decided ({decided.length}) {showDecided ? "▾" : "▸"}
              </CardTitle>
            </button>
          </CardHeader>
          {showDecided && (
            <CardContent className="space-y-2">
              {decided.slice(0, 30).map((d) => (
                <StepCard
                  key={d.id}
                  title={
                    <span className="inline-flex items-center gap-1.5">
                      {d.state === "approved" ? (
                        <CheckCircle2 className="text-[var(--live)]" />
                      ) : d.state === "discarded" ? (
                        <Trash2 className="text-destructive" />
                      ) : (
                        <Undo2 className="text-muted-foreground" />
                      )}
                      {d.subject ?? `Ticket #${d.ticketId}`}
                    </span>
                  }
                  meta={
                    <>
                      {d.state}
                      {d.decidedBy ? ` by ${d.decidedBy}` : ""}
                      {d.editedBody ? " · edited" : ""} · <RelativeTime at={d.decidedAt ?? d.createdAt} />
                    </>
                  }
                >
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {(d.editedBody ?? d.suggestedReply).slice(0, 160)}…
                  </p>
                </StepCard>
              ))}
            </CardContent>
          )}
        </Card>
      )}
    </>
  );
}
