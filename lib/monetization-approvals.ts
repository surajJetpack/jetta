/**
 * Resolve a pending monday monetization approval (trial extension / discount).
 * Shared by both approval surfaces — the Slack `approve/reject monet` commands
 * and the /billing console queue — so the execute-or-discard logic lives in one
 * place. Approving runs the real monday call (still bounded by
 * MONDAY_MONETIZATION_ALLOW_WRITES); rejecting just discards the request.
 */
import { getMonetApproval, deleteMonetApproval } from "./kv";
import type { AppProduct } from "./types";
import * as monetization from "./tools/monday-monetization";

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
