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
  subscriptionId: null,
  planName: null,
  planPrice: null,
  billingCycle: null,
  nextChargeDate: null,
  paymentMethod: null,
  activeLast30Days: false,
  invoices: [] as FastSpringInvoice[],
});

// Partial shapes of the FastSpring objects we read (see /accounts, /subscriptions,
// /orders responses). Only the fields we use are typed.
type FSAccountObj = { id: string; subscriptions?: string[]; orders?: string[] };
type FSSubscription = {
  id: string;
  active?: boolean;
  state?: string;
  product?: string;
  display?: string;
  priceDisplay?: string;
  intervalUnit?: string;
  nextDisplayISO8601?: string;
  changed?: number;
  paymentMethodType?: string;
};
type FSPayment = { type?: string; creditcard?: string; cardEnding?: string };
type FSOrder = {
  id?: string;
  order?: string;
  invoiceUrl?: string;
  totalDisplay?: string;
  changed?: number;
  changedDisplayISO8601?: string;
  payment?: FSPayment;
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Mastercard ····5937" / "PayPal" / "Credit card", or null. */
function formatPaymentMethod(pay: FSPayment | undefined, fallbackType?: string): string | null {
  if (pay) {
    if (pay.creditcard || pay.type === "creditcard") {
      const brand = pay.creditcard ? cap(pay.creditcard) : "Card";
      return pay.cardEnding ? `${brand} ····${pay.cardEnding}` : brand;
    }
    if (pay.type === "paypal") return "PayPal";
    if (pay.type) return cap(pay.type);
  }
  if (fallbackType) {
    if (fallbackType === "paypal") return "PayPal";
    if (fallbackType === "creditcard") return "Credit card";
    return cap(fallbackType);
  }
  return null;
}

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

  // 1. Resolve the account id by email. The list endpoint returns id strings;
  //    a filtered query may return objects — normalize either shape.
  const search = await fs<{ accounts?: (string | { id: string })[] }>(
    `/accounts?email=${encodeURIComponent(email)}`,
    store,
  ).catch(() => null);
  const first = search?.accounts?.[0];
  const accountId = typeof first === "string" ? first : first?.id;
  if (!accountId) return NOT_FOUND(email);

  // 2. The canonical account object carries the subscription + order id arrays
  //    (there is no working /accounts/{id}/subscriptions endpoint — it 404s).
  const account = await fs<FSAccountObj>(`/accounts/${accountId}`, store).catch(() => null);
  if (!account) return NOT_FOUND(email);

  // 3. Fetch each subscription; prefer an active one, else the most recent.
  const subs = (
    await Promise.all(
      (account.subscriptions ?? []).map((id) =>
        fs<FSSubscription>(`/subscriptions/${id}`, store).catch(() => null),
      ),
    )
  ).filter((s): s is FSSubscription => !!s);
  const sub =
    subs.find((s) => s.active) ??
    [...subs].sort((a, b) => (b.changed ?? 0) - (a.changed ?? 0))[0] ??
    null;

  // 4. Invoices come from orders (newest first, capped); invoiceUrl is per-order.
  const orders = (
    await Promise.all(
      (account.orders ?? []).slice(0, 12).map((id) =>
        fs<FSOrder>(`/orders/${id}`, store).catch(() => null),
      ),
    )
  )
    .filter((o): o is FSOrder => !!o)
    .sort((a, b) => (b.changed ?? 0) - (a.changed ?? 0));

  const invoices: FastSpringInvoice[] = orders.map((o) => ({
    id: o.order ?? o.id ?? "",
    date: o.changedDisplayISO8601 ?? "",
    amount: o.totalDisplay ?? "",
    url: o.invoiceUrl ?? null,
  }));

  // 5. Payment method: the newest order's payment block carries card brand +
  //    last four; fall back to the subscription's payment-method type.
  const pay = orders.find((o) => o.payment)?.payment;

  return {
    found: true,
    email,
    accountId,
    subscriptionId: sub?.id ?? null,
    planName: sub?.display ?? sub?.product ?? null,
    planPrice: sub?.priceDisplay ?? null,
    billingCycle: sub?.intervalUnit ?? null,
    nextChargeDate: sub?.nextDisplayISO8601 ?? null,
    paymentMethod: formatPaymentMethod(pay, sub?.paymentMethodType),
    // Real signal now: an ACTIVE subscription (not just "a subscription exists").
    activeLast30Days: sub?.active === true,
    invoices,
  };
}

/**
 * Resolve a downloadable invoice URL. Our invoice ids are FastSpring order ids,
 * and the invoiceUrl lives on the order object.
 */
export async function getInvoiceUrl(invoiceId: string, appProduct: AppProduct): Promise<string> {
  const store = storeFor(appProduct);
  if (!config.fastspring.live || !store) {
    return `https://fastspring.com/invoice/${invoiceId}.pdf`;
  }
  const order = await fs<FSOrder>(`/orders/${invoiceId}`, store);
  if (!order.invoiceUrl) throw new Error(`No invoice URL for order ${invoiceId}`);
  return order.invoiceUrl;
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

  // Re-fetch the subscription so we can report the actual discounted price and
  // the date it takes effect, rather than a placeholder.
  const updated = await fs<FSSubscription>(`/subscriptions/${subscriptionId}`, store).catch(() => null);
  return {
    newPrice: updated?.priceDisplay ?? "(see account)",
    effectiveDate: updated?.nextDisplayISO8601 ?? "next billing cycle",
  };
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
