/**
 * Resolve a pending monday monetization approval (trial extension / discount).
 * Shared by both approval surfaces — the Slack `approve/reject monet` commands
 * and the /billing console queue — so the execute-or-discard logic lives in one
 * place. Approving runs the real monday call (still bounded by
 * MONDAY_MONETIZATION_ALLOW_WRITES); rejecting just discards the request.
 */
import {
  getMonetApproval,
  deleteMonetApproval,
  saveMonetApproval,
  listMonetApprovals,
  type MonetApproval,
} from "./kv";
import type { AppProduct } from "./types";
import * as monetization from "./tools/monday-monetization";
import * as slack from "./tools/slack";

export interface MonetRequestInput {
  action: "trial" | "discount";
  app: string;
  accountSlug: string;
  days?: number;
  percent?: number;
  daysValid?: number;
  period?: "MONTHLY" | "YEARLY";
  ticketId?: string;
  /** Human-readable summary for the Slack message, e.g. "set trial to 23 days". */
  summary: string;
  ticketUrl?: string;
}

/** Two requests are duplicates when every identifying field matches. */
function sameRequest(a: MonetApproval, b: MonetRequestInput): boolean {
  return (
    a.action === b.action &&
    a.app === b.app &&
    a.accountSlug === b.accountSlug &&
    a.days === b.days &&
    a.percent === b.percent &&
    a.daysValid === b.daysValid &&
    a.period === b.period
  );
}

/**
 * Create a pending approval + post it to Slack — unless an identical one is
 * already pending, in which case reuse it (dedup guard: LLMs sometimes call the
 * tool twice, which would otherwise queue duplicate requests).
 */
export async function submitMonetApproval(input: MonetRequestInput): Promise<{ id: string; deduped: boolean }> {
  const existing = (await listMonetApprovals()).find((a) => sameRequest(a, input));
  if (existing) return { id: existing.id, deduped: true };

  const id = crypto.randomUUID().slice(0, 6);
  await saveMonetApproval({
    id,
    action: input.action,
    app: input.app,
    accountSlug: input.accountSlug,
    days: input.days,
    percent: input.percent,
    daysValid: input.daysValid,
    period: input.period,
    ticketId: input.ticketId,
    createdAt: Math.floor(Date.now() / 1000),
  });
  await slack.requestMonetApproval({
    id,
    action: input.action,
    app: input.app,
    accountSlug: input.accountSlug,
    summary: input.summary,
    ticketUrl: input.ticketUrl,
  });
  return { id, deduped: false };
}

export interface ResolveResult {
  ok: boolean;
  /** Human-readable outcome, safe to show in Slack or the console. */
  message: string;
  /** True only when the request id existed (false = expired/already handled). */
  found: boolean;
}

export async function resolveMonetApproval(
  id: string,
  decision: "approve" | "reject",
  actor: string,
): Promise<ResolveResult> {
  const appr = await getMonetApproval(id);
  if (!appr) {
    return { ok: false, found: false, message: `No pending approval for “${id}” (it may have expired or already been handled).` };
  }
  const app = appr.app as AppProduct;

  if (decision === "reject") {
    await deleteMonetApproval(id);
    return { ok: true, found: true, message: `Rejected the ${appr.action} request for ${appr.accountSlug}. Nothing was changed.` };
  }

  // approve → execute the real monday call
  let ok: boolean;
  let message: string;
  if (appr.action === "trial") {
    const r = await monetization.extendTrial(app, appr.accountSlug, appr.days ?? 14);
    ok = r.success;
    message = r.success
      ? `Trial for ${appr.accountSlug} (${app}) set to ${appr.days} days.`
      : `Approved, but monday did not apply the trial for ${appr.accountSlug}: ${r.reason}.`;
  } else {
    const r = await monetization.applyDiscount(app, appr.accountSlug, {
      percent: appr.percent ?? 0,
      daysValid: appr.daysValid ?? 30,
      period: appr.period ?? "MONTHLY",
    });
    ok = r.applied;
    message = r.applied
      ? `Discount applied to ${appr.accountSlug} (${app}): ${r.detail}.`
      : `Approved, but the discount was not applied for ${appr.accountSlug}: ${r.detail}.`;
  }
  // Consume the request only on a real success — a no-op (writes gated) or a
  // monday error keeps it pending so it can be retried, mirroring ReplyDraft.
  if (ok) await deleteMonetApproval(id);
  void actor; // logged by the caller
  return { ok, found: true, message };
}
