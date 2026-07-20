/**
 * FastSpring tool client — billing read/write.
 *
 * Mutating calls (apply_discount, cancel_subscription) are real money, so the
 * stub branch is especially important during development.
 */
import { config } from "../config";
import type { AppProduct, FastSpringAccount, FastSpringInvoice } from "../types";

const BASE = "https://api.fastspring.com";

/** Store credentials for the app, if one is configured. */
function storeFor(appProduct: AppProduct): { username?: string; password?: string } | undefined {
  const store = (config.fastspring.stores as Record<string, { username?: string; password?: string }>)[
    appProduct
  ];
  return store?.username && store?.password ? store : undefined;
}

function fsHeaders(store: { username?: string; password?: string }): HeadersInit {
  const token = Buffer.from(`${store.username}:${store.password}`).toString("base64");
  return { Authorization: `Basic ${token}`, "Content-Type": "application/json" };
}

async function fs<T>(
  path: string,
  store: { username?: string; password?: string },
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: fsHeaders(store) });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`FastSpring ${init?.method ?? "GET"} ${path} failed: ${res.status} ${body}`);
  }
  return (await res.json()) as T;
}

function configuredAppProducts(): AppProduct[] {
  return (Object.keys(config.fastspring.stores) as AppProduct[]).filter((p) => storeFor(p));
}

/**
 * The Slack admin commands (apply discount / confirm cancel) only get an
 * email, with no ticket to infer the app from — so search every store that
 * has credentials configured and return the first match.
 */
export async function findAccountAcrossStores(
  email: string,
): Promise<{ appProduct: AppProduct; account: FastSpringAccount } | null> {
  if (!config.fastspring.live) return null;
  for (const appProduct of configuredAppProducts()) {
    const account = await getFastSpringAccount(email, appProduct);
    if (account.found) return { appProduct, account };
  }
  return null;
}

const NOT_FOUND = (email: string): FastSpringAccount => ({
  found: false,
  email,
  accountId: null,
  planName: null,
  billingCycle: null,
  nextChargeDate: null,
  cardLastFour: null,
  activeLast30Days: false,
  invoices: [] as FastSpringInvoice[],
});

export async function getFastSpringAccount(
  email: string,
  appProduct: AppProduct,
): Promise<FastSpringAccount> {
  // SAFETY: never fabricate account data. Plausible stub values leak into real
  // customer drafts when other integrations are live but this one isn't
  // (found on the 2026-07-12 human benchmark). found:false reads as "no linked
  // billing account" everywhere downstream — used both for the global stub
  // mode and for apps that don't have a FastSpring store configured yet.
  const store = storeFor(appProduct);
  if (!config.fastspring.live || !store) return NOT_FOUND(email);

  type FSAccount = { id: string };
  type FSSubscription = {
    id: string;
    product?: string;
    display?: string;
    interval?: string;
    next?: string | number;
    instructions?: { discountPercentValue?: number }[];
    account?: string;
  };

  // Look the account up by email, then pull its subscriptions.
  const accounts = await fs<{ accounts: FSAccount[] }>(
    `/accounts?email=${encodeURIComponent(email)}`,
    store,
  );
  const account = accounts.accounts?.[0];
  if (!account) return NOT_FOUND(email);

  const subs = await fs<{ subscriptions: FSSubscription[] }>(
    `/accounts/${account.id}/subscriptions`,
    store,
  );
  const sub = subs.subscriptions?.[0];

  return {
    found: true,
    email,
    accountId: account.id,
    planName: sub?.display ?? sub?.product ?? null,
    billingCycle: sub?.interval ?? null,
    nextChargeDate: sub?.next ? String(sub.next) : null,
    cardLastFour: null,
    // FastSpring does not return a single "active usage" flag; treat an active
    // subscription as the proxy for recent usage. Refine once usage data exists.
    activeLast30Days: !!sub,
    invoices: [],
  };
}

export async function getInvoiceUrl(invoiceId: string, appProduct: AppProduct): Promise<string> {
  const store = storeFor(appProduct);
  if (!config.fastspring.live || !store) {
    return `https://fastspring.com/invoice/${invoiceId}.pdf`;
  }
  const res = await fs<{ invoiceUrl?: string; url?: string }>(`/invoices/${invoiceId}`, store);
  const url = res.invoiceUrl ?? res.url;
  if (!url) throw new Error(`No invoice URL for ${invoiceId}`);
  return url;
}

export async function applyDiscount(
  subscriptionId: string,
  coupon: string,
  appProduct: AppProduct,
): Promise<{ newPrice: string; effectiveDate: string }> {
  const store = storeFor(appProduct);
  if (!config.fastspring.live || !store) {
    console.log(`[stub] apply_discount coupon=${coupon} sub=${subscriptionId}`);
    return { newPrice: "$23.20", effectiveDate: "2026-06-19" };
  }
  if (!config.fastspring.allowWrites) {
    console.log(
      `[FASTSPRING_ALLOW_WRITES=false] would apply_discount coupon=${coupon} sub=${subscriptionId} — no write made.`,
    );
    return { newPrice: "(see account)", effectiveDate: "next billing cycle" };
  }
  const res = await fs<{ subscriptions: { id: string }[] }>(
    `/subscriptions`,
    store,
    { method: "POST", body: JSON.stringify({ subscriptions: [{ subscription: subscriptionId, coupon }] }) },
  );
  if (!res.subscriptions?.length) throw new Error("apply_discount returned no subscription");
  return { newPrice: "(see account)", effectiveDate: "next billing cycle" };
}

export async function cancelSubscription(
  subscriptionId: string,
  appProduct: AppProduct,
): Promise<{ accessEndsDate: string }> {
  const store = storeFor(appProduct);
  if (!config.fastspring.live || !store) {
    console.log(`[stub] cancel_subscription sub=${subscriptionId}`);
    return { accessEndsDate: "2026-06-19" };
  }
  if (!config.fastspring.allowWrites) {
    console.log(`[FASTSPRING_ALLOW_WRITES=false] would cancel_subscription sub=${subscriptionId} — no write made.`);
    return { accessEndsDate: "end of current billing period" };
  }
  // Cancel at end of current billing period (not immediate).
  await fs(`/subscriptions/${subscriptionId}`, store, { method: "DELETE" });
  return { accessEndsDate: "end of current billing period" };
}
