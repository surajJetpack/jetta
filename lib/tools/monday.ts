/**
 * monday.com tool client — Dev board search/create + Marketplace actions.
 *
 * Dev board items use the GraphQL API. `extend_trial` and
 * `apply_platform_discount` hit the monday Marketplace/platform API, which is
 * the least standardised part of this integration — the real calls are wrapped
 * here so the rest of the system depends only on the typed interface.
 */
import { config } from "../config";
import type { DevBoardItem } from "../types";

const GRAPHQL = "https://api.monday.com/v2";

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(GRAPHQL, {
    method: "POST",
    headers: {
      Authorization: config.monday.apiToken ?? "",
      "Content-Type": "application/json",
      "API-Version": "2024-10",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) {
    throw new Error(`monday GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  if (!json.data) throw new Error("monday GraphQL returned no data");
  return json.data;
}

function itemUrl(itemId: string): string {
  return `${config.monday.accountUrl}/boards/${config.monday.devBoardId}/pulses/${itemId}`;
}

export async function searchDevBoard(symptom: string): Promise<DevBoardItem[]> {
  if (!config.monday.live) {
    if (/mapping|map|column/i.test(symptom)) {
      return [
        {
          id: "5566778899",
          title: "[GetSign] Mapping editor: confirm-on-close UX confusion",
          status: "In Progress",
          url: itemUrl("5566778899"),
        },
      ];
    }
    return [];
  }

  // Fetch board items and score by token overlap with the symptom. monday's
  // native contains_text is a strict substring match on the full phrase, which
  // misses near-matches (e.g. "signed document syncing" vs "...not syncing...")
  // — and missing an existing item would make Jetta file a duplicate.
  const data = await gql<{
    boards: { items_page: { items: { id: string; name: string }[] } }[];
  }>(
    `query ($board: [ID!]) { boards(ids: $board) { items_page(limit: 100) { items { id name } } } }`,
    { board: [config.monday.devBoardId] },
  ).catch(() => null);

  const items = data?.boards?.[0]?.items_page?.items ?? [];
  const terms = symptom
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
  if (!terms.length) return [];

  return items
    .map((i) => {
      const name = i.name.toLowerCase();
      const score = terms.reduce((s, t) => s + (name.includes(t) ? 1 : 0), 0);
      return { i, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ i }) => ({ id: i.id, title: i.name, status: "open", url: itemUrl(i.id) }));
}

export interface CreateDevItemInput {
  title: string;
  product: string;
  accountUrl: string;
  errorDescription: string;
  reproSteps: string;
  freshdeskTicketUrl: string;
}

export async function createDevItem(input: CreateDevItemInput): Promise<DevBoardItem> {
  if (!config.monday.live) {
    const id = "9900112233";
    console.log(`[stub] create_dev_item "${input.title}"`);
    return { id, title: input.title, status: "New", url: itemUrl(id) };
  }

  const board = config.monday.devBoardId;

  // Discover the board's columns so we can populate structured fields by title,
  // adapting to whatever board is configured (test board or real bug tracker).
  const meta = await gql<{
    boards: { columns: { id: string; title: string; type: string }[] }[];
  }>(`query ($board: [ID!]) { boards(ids: $board) { columns { id title type } } }`, {
    board: [board],
  }).catch(() => null);
  const cols = meta?.boards?.[0]?.columns ?? [];
  const find = (type: string, kw: RegExp) =>
    cols.find((c) => c.type === type && kw.test(c.title.toLowerCase()))?.id;

  const cv: Record<string, unknown> = {};
  const stepsCol = find("long_text", /step|repro/);
  if (stepsCol) cv[stepsCol] = input.reproSteps;
  const errCol = find("long_text", /error|actual|description/);
  if (errCol) cv[errCol] = input.errorDescription;
  const acctCol = find("link", /account/);
  if (acctCol && input.accountUrl.startsWith("http")) {
    cv[acctCol] = { url: input.accountUrl, text: "Account" };
  }
  const tixCol = find("link", /ticket|freshdesk/);
  if (tixCol && input.freshdeskTicketUrl.startsWith("http")) {
    cv[tixCol] = { url: input.freshdeskTicketUrl, text: "Freshdesk ticket" };
  }

  const data = await gql<{ create_item: { id: string; name: string } }>(
    `mutation ($board: ID!, $name: String!, $cv: JSON!) {
      create_item(board_id: $board, item_name: $name, column_values: $cv) { id name }
    }`,
    { board, name: input.title, cv: JSON.stringify(cv) },
  );
  const id = data.create_item.id;

  // Also post the full context as an update — keeps product/ticket visible and
  // covers boards that lack matching columns.
  const body = [
    `Product: ${input.product}`,
    `Account: ${input.accountUrl}`,
    `Freshdesk ticket: ${input.freshdeskTicketUrl}`,
    "",
    `Error: ${input.errorDescription}`,
    "",
    `Reproduction steps:\n${input.reproSteps}`,
  ].join("\n");
  await gql(
    `mutation ($item: ID!, $body: String!) { create_update(item_id: $item, body: $body) { id } }`,
    { item: id, body },
  ).catch(() => undefined);

  return { id, title: input.title, status: "New", url: itemUrl(id) };
}

/** Add a "+1 / me too" note to an existing dev item. */
export async function addPlusOne(itemId: string, ticketUrl: string): Promise<void> {
  if (!config.monday.live) {
    console.log(`[stub] +1 on item ${itemId} from ${ticketUrl}`);
    return;
  }
  await gql(
    `mutation ($item: ID!, $body: String!) { create_update(item_id: $item, body: $body) { id } }`,
    { item: itemId, body: `+1 — another user affected. Freshdesk ticket: ${ticketUrl}` },
  );
}

export async function extendTrial(
  email: string,
  days: number,
): Promise<{ newTrialEndDate: string }> {
  if (!config.monday.live) {
    console.log(`[stub] extend_trial ${email} +${days}d`);
    return { newTrialEndDate: "2026-06-26" };
  }
  // monday Marketplace trial extension is account-specific; this is the
  // integration point to wire to the platform API once the endpoint is known.
  throw new Error(
    "extend_trial: live monday Marketplace API not yet wired — set STUB_MODE=true or implement.",
  );
}

export async function applyPlatformDiscount(
  email: string,
  percent: number,
): Promise<{ applied: boolean }> {
  if (!config.monday.live) {
    console.log(`[stub] apply_platform_discount ${email} ${percent}%`);
    return { applied: true };
  }
  throw new Error(
    "apply_platform_discount: live monday Marketplace API not yet wired — set STUB_MODE=true or implement.",
  );
}
