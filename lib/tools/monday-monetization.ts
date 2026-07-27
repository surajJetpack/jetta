/**
 * monday.com Marketplace monetization client — trial extension + per-account
 * discounts for monday-billed apps (the current billing path for the whole
 * portfolio; FastSpring is legacy-only).
 *
 * Distinct from lib/tools/monday.ts (the board GraphQL client): monetization
 * needs APP-level credentials — an app "collaborator token" — which the
 * board-scoped MONDAY_API_TOKEN cannot provide. Config is per-app (keyed by
 * AppProduct), mirroring config.fastspring.stores. Mutations target an
 * account_slug (not account id). See:
 *   https://developer.monday.com/apps/docs/extend-a-trial
 *   https://developer.monday.com/api-reference/reference/marketplace-app-discounts
 */
import { config } from "../config";
import type { AppProduct } from "../types";

const GRAPHQL = "https://api.monday.com/v2";
// Per-account discount mutation (create_marketplace_app_discount_offer) requires 2026-04+.
const API_VERSION = "2026-04";

interface Store {
  collaboratorToken?: string;
  appId?: string;
  planIds: string[];
}

/** Per-app monetization config, if the app has a token + appId configured. */
function storeFor(appProduct: AppProduct): Store | undefined {
  const s = config.monday.monetization.stores[appProduct];
  return s?.collaboratorToken && s?.appId ? s : undefined;
}

async function gql<T>(query: string, variables: Record<string, unknown>, token: string): Promise<T> {
  const res = await fetch(GRAPHQL, {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
      "API-Version": API_VERSION,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) {
    throw new Error(`monday monetization error: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  if (!json.data) throw new Error("monday monetization returned no data");
  return json.data;
}

/**
 * Normalize a monday account reference to its slug. Accepts a bare slug or a
 * monday URL (https://<slug>.monday.com/...). Returns null if unusable.
 */
export function parseAccountSlug(ref: string | null | undefined): string | null {
  const r = (ref ?? "").trim();
  if (!r) return null;
  const m = r.match(/^https?:\/\/([a-z0-9-]+)\.monday\.com/i);
  if (m) return m[1];
  // A bare slug: monday slugs are lowercase alphanumeric + hyphens, no dots/spaces.
  if (/^[a-z0-9-]+$/i.test(r)) return r;
  return null;
}

export interface TrialResult {
  success: boolean;
  reason: string;
}

/**
 * Extend an account's trial. NOTE: monday REPLACES the remaining trial with
 * `days` (not additive) — 5 days left + a 10-day extension = 10, not 15.
 */
export async function extendTrial(
  appProduct: AppProduct,
  accountSlug: string,
  days: number,
  planId?: string,
): Promise<TrialResult> {
  const store = storeFor(appProduct);
  if (!config.monday.live) {
    console.log(`[stub] monday extend_trial app=${appProduct} slug=${accountSlug} days=${days}`);
    return { success: true, reason: "stub" };
  }
  // Live but honest: never report success when we didn't (or couldn't) act.
  if (!store) return { success: false, reason: `monday monetization is not configured for ${appProduct}` };
  if (!config.monday.monetization.allowWrites) {
    console.log(
      `[MONDAY_MONETIZATION_ALLOW_WRITES=false] would extend_trial app=${appProduct} slug=${accountSlug} days=${days} — no write made.`,
    );
    return { success: false, reason: "writes disabled (MONDAY_MONETIZATION_ALLOW_WRITES=false) — nothing was changed" };
  }
  // monday only accepts the plan_id the account is actually on/trialing — any
  // other plan returns INTERNAL_ERROR. We can't read the account's plan with
  // the collaborator token (that needs per-account context / v2 webhooks), so
  // when no plan is given we try each configured plan until one succeeds. Every
  // failed attempt is a harmless no-op on monday's side.
  const plans = planId ? [planId] : store.planIds;
  if (!plans.length) throw new Error(`monday extend_trial: no plan_id configured for ${appProduct}`);

  let last: { success: boolean; reason: string } = { success: false, reason: "no plans tried" };
  for (const plan of plans) {
    const data = await gql<{
      batch_extend_trial_period: { success: boolean; reason: string; details: { account_slug: string; success: boolean; reason: string }[] };
    }>(
      `mutation ($slugs: [String!]!, $app: ID!, $plan: String!, $days: Int!) {
        batch_extend_trial_period(account_slugs: $slugs, app_id: $app, plan_id: $plan, duration_in_days: $days) {
          success reason details { account_slug success reason }
        }
      }`,
      { slugs: [accountSlug], app: store.appId, plan, days },
      store.collaboratorToken!,
    );
    const r = data.batch_extend_trial_period;
    const detail = r.details?.find((d) => d.account_slug === accountSlug);
    const success = detail?.success ?? r.success;
    if (success) return { success: true, reason: `plan ${plan}` };
    last = { success: false, reason: detail?.reason ?? r.reason ?? "unknown" };
  }
  return last;
}

export interface DiscountInput {
  /** Percent off, 1–100. */
  percent: number;
  /** How long the discount stays valid. */
  daysValid: number;
  period: "MONTHLY" | "YEARLY";
  /** Whether the discount recurs each billing cycle within the window. Default false (one-time offer). */
  isRecurring?: boolean;
  /** Plans the discount applies to; defaults to the app's configured planIds. */
  planIds?: string[];
}

export interface DiscountResult {
  applied: boolean;
  detail: string;
}

/** Grant a per-account discount (applies at the next billing cycle). */
export async function applyDiscount(
  appProduct: AppProduct,
  accountSlug: string,
  input: DiscountInput,
): Promise<DiscountResult> {
  const store = storeFor(appProduct);
  if (!config.monday.live) {
    console.log(`[stub] monday apply_discount app=${appProduct} slug=${accountSlug} ${input.percent}%`);
    return { applied: true, detail: "stub" };
  }
  if (!store) return { applied: false, detail: `monday monetization is not configured for ${appProduct}` };
  if (!config.monday.monetization.allowWrites) {
    console.log(
      `[MONDAY_MONETIZATION_ALLOW_WRITES=false] would apply_discount app=${appProduct} slug=${accountSlug} ${input.percent}% — no write made.`,
    );
    return { applied: false, detail: "writes disabled (MONDAY_MONETIZATION_ALLOW_WRITES=false) — nothing was changed" };
  }
  const planIds = input.planIds?.length ? input.planIds : store.planIds;
  // NB: the documented create_marketplace_app_discount_offer mutation does not
  // exist on this account's API — grant_marketplace_app_discount is the live one.
  const data = await gql<{ grant_marketplace_app_discount: { granted_discount: { discount: number; period: string | null; app_plan_ids: string[] } } }>(
    `mutation ($app: ID!, $slug: String!, $data: GrantMarketplaceAppDiscountData!) {
      grant_marketplace_app_discount(app_id: $app, account_slug: $slug, data: $data) {
        granted_discount { discount period app_plan_ids }
      }
    }`,
    {
      app: store.appId,
      slug: accountSlug,
      data: {
        discount: input.percent,
        days_valid: input.daysValid,
        period: input.period,
        is_recurring: input.isRecurring ?? false,
        app_plan_ids: planIds,
      },
    },
    store.collaboratorToken!,
  );
  const g = data.grant_marketplace_app_discount?.granted_discount;
  return { applied: !!g, detail: g ? `${g.discount}% ${(g.period ?? "").toLowerCase()} on ${g.app_plan_ids.join(", ")}` : "no discount returned" };
}

export interface AppDiscount {
  accountSlug: string;
  discount: number;
  period: string;
  isRecurring: boolean;
  validUntil: string;
  appPlanIds: string[];
}

/** List active discounts for an app (read; also useful to confirm a grant). */
export async function listDiscounts(appProduct: AppProduct): Promise<AppDiscount[]> {
  const store = storeFor(appProduct);
  if (!config.monday.live || !store) return [];
  const data = await gql<{
    marketplace_app_discounts: { account_slug: string; discount: number; period: string; is_recurring: boolean; valid_until: string; app_plan_ids: string[] }[];
  }>(
    `query ($app: ID!) {
      marketplace_app_discounts(app_id: $app) { account_slug discount period is_recurring valid_until app_plan_ids }
    }`,
    { app: store.appId },
    store.collaboratorToken!,
  );
  return (data.marketplace_app_discounts ?? []).map((d) => ({
    accountSlug: d.account_slug,
    discount: d.discount,
    period: d.period,
    isRecurring: d.is_recurring,
    validUntil: d.valid_until,
    appPlanIds: d.app_plan_ids,
  }));
}

/** Remove an account's discount (reverses applyDiscount). */
export async function deleteDiscount(appProduct: AppProduct, accountSlug: string): Promise<boolean> {
  const store = storeFor(appProduct);
  if (!config.monday.live) {
    console.log(`[stub] monday delete_discount app=${appProduct} slug=${accountSlug}`);
    return true;
  }
  if (!store) return false;
  if (!config.monday.monetization.allowWrites) {
    console.log(`[MONDAY_MONETIZATION_ALLOW_WRITES=false] would delete_discount app=${appProduct} slug=${accountSlug} — no write made.`);
    return false;
  }
  await gql(
    `mutation ($app: ID!, $slug: String!) { delete_marketplace_app_discount(app_id: $app, account_slug: $slug) { __typename } }`,
    { app: store.appId, slug: accountSlug },
    store.collaboratorToken!,
  );
  return true;
}
