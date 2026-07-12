/**
 * FastSpring tool client — billing read/write.
 *
 * Mutating calls (apply_discount, cancel_subscription) are real money, so the
 * stub branch is especially important during development.
 */
import { config } from "../config";
import type { FastSpringAccount, FastSpringInvoice } from "../types";

const BASE = "https://api.fastspring.com";

function fsHeaders(): HeadersInit {
  const token = Buffer.from(
    `${config.fastspring.username}:${config.fastspring.password}`,
  ).toString("base64");
  return { Authorization: `Basic ${token}`, "Content-Type": "application/json" };
}

async function fs<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: fsHeaders() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`FastSpring ${init?.method ?? "GET"} ${path} failed: ${res.status} ${body}`);
  }
  return (await res.json()) as T;
}

export async function getFastSpringAccount(email: string): Promise<FastSpringAccount> {
  if (!config.fastspring.live) {
    // SAFETY: never fabricate account data. Plausible stub values leak into
    // real customer drafts when other integrations are live but billing isn't
    // (found on the 2026-07-12 human benchmark). found:false reads as
    // "no linked billing account" everywhere downstream.
    return {
      found: false,
      email,
      accountId: null,
      planName: null,
      billingCycle: null,
      nextChargeDate: null,
      cardLastFour: null,
      activeLast30Days: false,
      invoices: [] as FastSpringInvoice[],
    };
  }

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
  );
  const account = accounts.accounts?.[0];
  if (!account) {
    return {
      found: false,
      email,
      accountId: null,
      planName: null,
      billingCycle: null,
      nextChargeDate: null,
      cardLastFour: null,
      activeLast30Days: false,
      invoices: [],
    };
  }

  const subs = await fs<{ subscriptions: FSSubscription[] }>(
    `/accounts/${account.id}/subscriptions`,
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

export async function getInvoiceUrl(invoiceId: string): Promise<string> {
  if (!config.fastspring.live) {
    return `https://fastspring.com/invoice/${invoiceId}.pdf`;
  }
  const res = await fs<{ invoiceUrl?: string; url?: string }>(`/invoices/${invoiceId}`);
  const url = res.invoiceUrl ?? res.url;
  if (!url) throw new Error(`No invoice URL for ${invoiceId}`);
  return url;
}

export async function applyDiscount(
  subscriptionId: string,
  coupon: string,
): Promise<{ newPrice: string; effectiveDate: string }> {
  if (!config.fastspring.live) {
    console.log(`[stub] apply_discount coupon=${coupon} sub=${subscriptionId}`);
    return { newPrice: "$23.20", effectiveDate: "2026-06-19" };
  }
  const res = await fs<{ subscriptions: { id: string }[] }>(`/subscriptions`, {
    method: "POST",
    body: JSON.stringify({ subscriptions: [{ subscription: subscriptionId, coupon }] }),
  });
  if (!res.subscriptions?.length) throw new Error("apply_discount returned no subscription");
  return { newPrice: "(see account)", effectiveDate: "next billing cycle" };
}

export async function cancelSubscription(
  subscriptionId: string,
): Promise<{ accessEndsDate: string }> {
  if (!config.fastspring.live) {
    console.log(`[stub] cancel_subscription sub=${subscriptionId}`);
    return { accessEndsDate: "2026-06-19" };
  }
  // Cancel at end of current billing period (not immediate).
  await fs(`/subscriptions/${subscriptionId}`, {
    method: "DELETE",
  });
  return { accessEndsDate: "end of current billing period" };
}
