"use client";

import { useCallback, useState } from "react";
import { CheckCircle2, ExternalLink, HandCoins, Hourglass, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { StepCard } from "@/components/jetta/step-card";
import { StatusChip } from "@/components/jetta/status-chip";
import { ConfirmButton } from "@/components/jetta/confirm-button";
import { EmptyState } from "@/components/jetta/empty-state";
import { RelativeTime } from "@/components/jetta/relative-time";
import { usePolling } from "@/lib/use-polling";

interface MonetApproval {
  id: string;
  action: "trial" | "discount";
  app: string;
  accountSlug: string;
  days?: number;
  percent?: number;
  daysValid?: number;
  period?: "MONTHLY" | "YEARLY";
  ticketId?: string;
  createdAt: number;
}

function summary(a: MonetApproval): string {
  return a.action === "trial"
    ? `Set trial to ${a.days} days`
    : `${a.percent}% off ${(a.period ?? "").toLowerCase()} · valid ${a.daysValid} days (one-time)`;
}

function ApprovalCard({
  appr,
  freshdeskDomain,
  onDecide,
}: {
  appr: MonetApproval;
  freshdeskDomain: string;
  onDecide: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function decide(action: "approve" | "reject") {
    setBusy(true);
    const r = await fetch("/api/admin/monetization", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: appr.id, action }),
    });
    const j = (await r.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
    setBusy(false);
    if (r.status === 404) toast.warning("This request was already handled — refreshing.");
    else if (!r.ok && r.status !== 200) toast.error(`Failed: ${j?.message ?? r.statusText}`);
    else if (action === "reject") toast.success(j?.message ?? "Rejected.");
    else if (j?.ok) toast.success(j?.message ?? "Approved & applied.");
    else toast.warning(j?.message ?? "Approved, but nothing was applied."); // e.g. writes gated
    onDecide();
  }

  return (
    <StepCard
      title={
        <span className="inline-flex items-center gap-1.5">
          {appr.action === "trial" ? <Hourglass /> : <HandCoins />}
          <span className="capitalize">{appr.action}</span>
          <span className="font-mono text-muted-foreground">{appr.app}</span>
        </span>
      }
      meta={
        <>
          <code className="font-mono">{appr.accountSlug}</code> · <RelativeTime at={appr.createdAt} />
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <StatusChip tone={appr.action === "trial" ? "draft" : "published"}>{summary(appr)}</StatusChip>
        {appr.ticketId && (
          <a
            href={`https://${freshdeskDomain}/a/tickets/${appr.ticketId}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
          >
            #{appr.ticketId} <ExternalLink className="size-3.5" />
          </a>
        )}
        <span className="font-mono text-xs text-muted-foreground">ref {appr.id}</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <ConfirmButton
          title={`Approve this ${appr.action}?`}
          description={`${summary(appr)} for monday account "${appr.accountSlug}" (${appr.app}). This applies on monday immediately once approved.`}
          confirmLabel="Approve & apply"
          onConfirm={() => decide("approve")}
          disabled={busy}
          busy={busy}
        >
          <CheckCircle2 /> {busy ? "Working…" : "Approve"}
        </ConfirmButton>
        <Button variant="destructive" size="default" disabled={busy} onClick={() => decide("reject")}>
          <Trash2 /> Reject
        </Button>
      </div>
    </StepCard>
  );
}

export default function TrialsDiscountsQueue({
  freshdeskDomain,
  writesEnabled,
}: {
  freshdeskDomain: string;
  writesEnabled: boolean;
}) {
  const [approvals, setApprovals] = useState<MonetApproval[] | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/admin/monetization", { cache: "no-store" }).then((x) => x.json());
    setApprovals(r.approvals ?? []);
  }, []);
  usePolling(load, 60_000);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Trials &amp; discounts{approvals ? ` (${approvals.length} pending)` : ""}</CardTitle>
        <CardAction>
          <Button variant="ghost" size="sm" onClick={() => { setApprovals(null); void load(); }}>
            Refresh
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-2.5">
        <p className="text-sm text-muted-foreground">
          Jetta requests a trial extension or discount; you approve or reject it here (or in Slack). Approving
          applies it on the customer&apos;s monday account.
        </p>
        {!writesEnabled && (
          <Alert>
            <TriangleAlert />
            <AlertTitle>
              monday writes are disabled — approvals are recorded but nothing is applied until
              MONDAY_MONETIZATION_ALLOW_WRITES=true. A gated approval stays in the queue so it can be retried.
            </AlertTitle>
          </Alert>
        )}
        {approvals === null && (
          <div className="space-y-2.5">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-2/3" />
          </div>
        )}
        {approvals?.map((a) => (
          <ApprovalCard key={a.id} appr={a} freshdeskDomain={freshdeskDomain} onDecide={load} />
        ))}
        {approvals !== null && approvals.length === 0 && (
          <EmptyState
            title="No pending trial or discount requests"
            hint="When Jetta proposes a trial extension or discount, it appears here for approval — this page refreshes every minute."
          />
        )}
      </CardContent>
    </Card>
  );
}
