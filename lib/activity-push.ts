/**
 * Pushed activity — Slack and monday tell Jetta when a person acts, so most of
 * /activity arrives with no read at all. lib/activity-sync.ts still runs, but
 * for a source whose push is healthy it only does a once-a-day safety-net read.
 *
 *   Slack   message.channels / message.groups events → app/api/slack/route.ts
 *   monday  board webhooks we register (registerMondayWebhooks) →
 *           app/api/webhook/monday-activity/route.ts
 *
 * Costs per event: Slack none, unless the person is new (one users.info, ever).
 * monday none, unless the user is new (one users query, ever).
 */
import { config } from "./config";
import {
  activityFromMondayWebhook,
  activityFromSlackEvent,
  type MondayWebhookEvent,
  type SlackMessageEvent,
} from "./activity";
import {
  claimFirstReply,
  getActivityState,
  getJettaPost,
  getMondayUsers,
  getSlackNames,
  markPush,
  recordActivities,
  saveActivityState,
  saveMondayUsers,
  saveSlackNames,
} from "./activity-store";

/** The monday events worth a webhook. Everything else on a board is tidying. */
export const MONDAY_EVENTS = ["create_update", "change_column_value", "create_item", "item_moved_to_any_group"] as const;

// ── Slack ───────────────────────────────────────────────────────────

const channelIds = () =>
  new Set(
    [config.slack.escalationChannel, config.slack.chatChannel, config.slack.opsChannel, config.slack.draftsChannel]
      .filter(Boolean)
      .map((c) => c!.replace(/^#/, "")),
  );

/** Jetta's own channels only: she may be invited elsewhere, and that is not support work. */
export function isActivityChannel(channel: string): boolean {
  return !!channel && channelIds().has(channel);
}

export async function recordSlackActivity(e: SlackMessageEvent): Promise<void> {
  try {
    await markPush("slack");
    if (!e.user || e.bot_id || (e.subtype && e.subtype !== "thread_broadcast")) return;
    const isReply = !!e.thread_ts && e.thread_ts !== e.ts;
    const [state, parent] = await Promise.all([
      getActivityState(),
      isReply ? getJettaPost(e.channel, e.thread_ts!) : Promise.resolve(null),
    ]);
    // Only a reply under HER post ends a wait; claim it only then, so a
    // person's thread doesn't burn the marker.
    const first = parent ? await claimFirstReply(e.channel, e.thread_ts!) : false;
    const act = activityFromSlackEvent(e, state.slackChannelNames?.[e.channel] ?? e.channel, parent, first);
    if (!act) return;
    await recordActivities([act]);
    await nameSlackUser(e.user);
  } catch (err) {
    console.warn(`activity: slack push failed — ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function nameSlackUser(id: string): Promise<void> {
  const known = await getSlackNames();
  if (known[id] || !config.slack.botToken) return;
  const res = await fetch(`https://slack.com/api/users.info?user=${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${config.slack.botToken}` },
  });
  const u = (await res.json()) as {
    ok: boolean;
    user?: { real_name?: string; name?: string; profile?: { real_name?: string; display_name?: string } };
  };
  const n = u.user?.profile?.real_name || u.user?.real_name || u.user?.profile?.display_name || u.user?.name;
  if (u.ok && n) await saveSlackNames({ [id]: n });
}

// ── monday ──────────────────────────────────────────────────────────

async function mondayGql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: {
      Authorization: config.monday.apiToken ?? "",
      "Content-Type": "application/json",
      "API-Version": "2024-10",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: { message: string }[]; error_message?: string };
  if (json.errors?.length) throw new Error(`monday: ${json.errors.map((e) => e.message).join("; ")}`);
  if (json.error_message) throw new Error(`monday: ${json.error_message}`);
  if (!json.data) throw new Error("monday returned no data");
  return json.data;
}

export async function handleMondayWebhook(e: MondayWebhookEvent): Promise<void> {
  await markPush("monday");
  const userId = e.userId != null ? String(e.userId) : "";
  if (!userId || userId === "-4") return; // -4 = monday automations, not a person
  const [state, users] = await Promise.all([getActivityState(), getMondayUsers()]);
  if (!users.has(userId)) {
    const got = await mondayGql<{ users: { id: string; name: string }[] }>(
      `query($ids:[ID!]){ users(ids: $ids) { id name } }`,
      { ids: [userId] },
    ).catch(() => null);
    for (const u of got?.users ?? []) users.set(String(u.id), u.name);
    await saveMondayUsers(users);
  }
  const boardName = state.mondayBoards?.[String(e.boardId)] ?? "dev board";
  const act = activityFromMondayWebhook(e, users, config.monday.accountUrl, boardName, state.mondaySelf?.id ?? null);
  if (act) await recordActivities([act]);
}

/** Where monday posts. The shared webhook secret rides in the URL: monday doesn't sign token-made webhooks. */
export function mondayWebhookUrl(): string | null {
  if (!config.appUrl || !config.webhook.secret) return null;
  return `${config.appUrl}/api/webhook/monday-activity?k=${encodeURIComponent(config.webhook.secret)}`;
}

export interface RegisterResult {
  ok: boolean;
  created: number;
  already: number;
  problem?: string;
}

/**
 * Subscribe /activity to both dev boards. Idempotent: a board/event pair we
 * already registered is skipped. A write to monday (webhooks only — no items,
 * no columns), so it follows MONDAY_ALLOW_WRITES like every other monday write.
 */
export async function registerMondayWebhooks(): Promise<RegisterResult> {
  if (!config.monday.live || !config.monday.apiToken) return { ok: false, created: 0, already: 0, problem: "monday is not connected." };
  if (!config.monday.allowWrites) return { ok: false, created: 0, already: 0, problem: "MONDAY_ALLOW_WRITES is off." };
  const url = mondayWebhookUrl();
  if (!url) return { ok: false, created: 0, already: 0, problem: "JETTA_APP_URL and WEBHOOK_SECRET must both be set." };
  const boardIds = [...new Set(Object.values(config.monday.boardIds).filter(Boolean) as string[])];
  const state = await getActivityState();
  const hooks = { ...state.mondayWebhooks };
  let created = 0;
  let already = 0;
  for (const board of boardIds) {
    const have = new Set(hooks[board] ?? []);
    for (const event of MONDAY_EVENTS) {
      if (have.has(event)) {
        already++;
        continue;
      }
      // monday answers the challenge POST synchronously while this runs, so the
      // receiving route must already be deployed.
      await mondayGql<{ create_webhook: { id: string } }>(
        `mutation($b: ID!, $u: String!, $e: WebhookEventType!){ create_webhook(board_id: $b, url: $u, event: $e) { id } }`,
        { b: board, u: url, e: event },
      );
      have.add(event);
      created++;
    }
    hooks[board] = [...have];
  }
  state.mondayWebhooks = hooks;
  await saveActivityState(state);
  return { ok: true, created, already };
}
