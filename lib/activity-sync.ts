/**
 * The activity sync — reads the places that don't tell Jetta when a person acts
 * there, into the activity store (lib/activity-store.ts).
 *
 * Freshdesk and the console need nothing here: Freshdesk replies are read off
 * the threads the performance sync already fetches, and console/chat actions
 * arrive through logOpsEvent. That leaves:
 *
 *   KB      the KB store's own audit list (capped at 1,000 — imported before it rolls)
 *   Slack   human messages in Jetta's channels, and replies under her posts
 *   monday  comments, status/assignee changes, moves and new items on the dev boards
 *
 * All reads, no writes anywhere but our own store. Each source fails on its
 * own: a missing Slack scope must not stop monday from being read, and the page
 * shows which source is not reporting and why.
 *
 * Hourly (vercel.json), and from the page's "Sync now".
 */
import { config } from "./config";
import { markEventSeen, unmarkEventSeen } from "./kv";
import { getAuditFeed } from "./kb-store";
import {
  activitiesFromSlackThread,
  activityFromEvent,
  activityFromKbAudit,
  activityFromMondayLog,
  activityFromMondayUpdate,
  type Activity,
  sameMondayAction,
  type MondayLog,
  type MondayUpdate,
  type SlackMsg,
} from "./activity";
import {
  getActivityState,
  getMondayUsers,
  getPushTimes,
  getSlackNames,
  loadActivities,
  pruneActivities,
  pruneJettaPosts,
  saveMondayUsers,
  recordActivities,
  saveActivityState,
  saveSlackNames,
  type ActivitySyncState,
  type SourceReport,
} from "./activity-store";
import { bumpDataVersion } from "./data-version";
import { getOpsEvents } from "./events";

const LOCK_ID = "activity-sync-lock";
/** A thread older than this is not read again, however recently it moved. */
const SLACK_LOOKBACK_DAYS = 28;
/** Thread reads per channel per run — Slack's history tier is ~50/min. */
const SLACK_THREADS_PER_RUN = 40;
/** First monday read reaches this far back. */
const MONDAY_BACKFILL_DAYS = 28;
/** Comments read per board per run (newest first, paged). */
const MONDAY_UPDATE_PAGES = 3;
/**
 * A pushed source still gets one full read a day — the net under a dropped
 * webhook or a Slack event lost to a cold start. Quiet for longer than
 * PUSH_STALE_MS (a long weekend) and it is read hourly again, in case the
 * push itself has stopped.
 */
const SAFETY_NET_MS = 24 * 3600_000;
const PUSH_STALE_MS = 72 * 3600_000;

export interface ActivitySyncResult {
  status: "ok" | "busy" | "partial";
  added: number;
  pruned: number;
  sources: ActivitySyncState["sources"];
}

/** `force` (the page's Sync now) reads every source regardless of push health. */
export async function syncActivity(opts: { force?: boolean } = {}): Promise<ActivitySyncResult> {
  if (!(await markEventSeen(LOCK_ID, 280))) return { status: "busy", added: 0, pruned: 0, sources: {} };
  try {
    const state = await getActivityState();
    const sources: NonNullable<ActivitySyncState["sources"]> = { ...state.sources };
    let added = 0;
    const run = async (name: keyof typeof sources, fn: () => Promise<{ acts: Activity[]; problem?: string }>) => {
      const at = Date.now();
      try {
        const { acts, problem } = await fn();
        await recordActivities(acts, { bump: false });
        added += acts.length;
        sources[name] = { at, ok: !problem, added: acts.length, problem };
      } catch (e) {
        sources[name] = { at, ok: false, added: 0, problem: e instanceof Error ? e.message : String(e) };
      }
    };

    // Once: the human events still in the ops log from before this store
    // existed. Same ids as the live hook, so a later overlap is harmless.
    if (!state.eventsImported) {
      await run("events", async () => ({
        acts: (await getOpsEvents({ limit: 5000 })).map(activityFromEvent).filter((a): a is Activity => !!a),
      }));
      if (sources.events?.ok) state.eventsImported = true;
    }
    await run("kb", () => readKb(state));

    const push = await getPushTimes();
    const now = Date.now();
    const due = (source: "slack" | "monday", pushReady: boolean) => {
      const fresh = pushReady && push[source] != null && now - push[source]! < PUSH_STALE_MS;
      const last = state.lastFullRead?.[source] ?? 0;
      return opts.force || !fresh || now - last >= SAFETY_NET_MS;
    };
    const mark = (source: "slack" | "monday") => {
      state.lastFullRead = { ...state.lastFullRead, [source]: now };
    };
    const modeOf = (source: "slack" | "monday", pushReady: boolean): SourceReport["mode"] =>
      pushReady && push[source] != null && now - push[source]! < PUSH_STALE_MS ? "push" : "poll";

    const slackPush = true; // Slack pushes once the app subscribes; nothing to register here.
    if (due("slack", slackPush)) {
      await run("slack", () => readSlack(state));
      mark("slack");
    }
    const mondayPush = Object.keys(state.mondayWebhooks ?? {}).length > 0;
    if (due("monday", mondayPush)) {
      await run("monday", () => readMonday(state));
      mark("monday");
    }
    for (const [source, ready] of [["slack", slackPush], ["monday", mondayPush]] as const) {
      if (sources[source]) sources[source] = { ...sources[source]!, mode: modeOf(source, ready), pushAt: push[source] };
    }

    const pruned = await pruneActivities().catch(() => 0);
    await pruneJettaPosts(now - 90 * 86_400_000).catch(() => {});
    state.sources = sources;
    state.lastRunAt = Date.now();
    await saveActivityState(state);
    await bumpDataVersion("activity");
    const failing = Object.values(sources).some((s: SourceReport | undefined) => s && !s.ok);
    return { status: failing ? "partial" : "ok", added, pruned, sources };
  } finally {
    await unmarkEventSeen(LOCK_ID);
  }
}

// ── KB ──────────────────────────────────────────────────────────────

async function readKb(state: ActivitySyncState): Promise<{ acts: Activity[] }> {
  const feed = await getAuditFeed(1000);
  const since = state.kbAt ?? 0;
  const acts: Activity[] = [];
  let newest = since;
  for (const a of feed) {
    newest = Math.max(newest, a.at);
    // Equal seconds are re-read on purpose: ids are deterministic, and a
    // second can hold several entries that straddle the previous run.
    if (a.at < since) continue;
    const act = activityFromKbAudit(a);
    if (act) acts.push(act);
  }
  state.kbAt = newest;
  return { acts };
}

// ── Slack ───────────────────────────────────────────────────────────

async function slackGet<T>(method: string, params: Record<string, string>): Promise<T & { ok: boolean; error?: string }> {
  const res = await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `Bearer ${config.slack.botToken}` },
  });
  return (await res.json()) as T & { ok: boolean; error?: string };
}

/** Jetta's channels, by id, once each (the chat channel may fall back to escalations). */
function slackChannels(): string[] {
  const s = config.slack;
  return [...new Set([s.escalationChannel, s.chatChannel, s.opsChannel, s.draftsChannel].filter(Boolean) as string[])].map(
    (c) => c.replace(/^#/, ""),
  );
}

async function readSlack(state: ActivitySyncState): Promise<{ acts: Activity[]; problem?: string }> {
  if (!config.slack.live || !config.slack.botToken) {
    return { acts: [], problem: "Slack is not connected in this environment." };
  }
  const acts: Activity[] = [];
  const problems: string[] = [];
  const seen = { ...state.slack };
  const oldest = String((Date.now() - SLACK_LOOKBACK_DAYS * 86_400_000) / 1000);

  for (const channel of slackChannels()) {
    let name = state.slackChannelNames?.[channel];
    if (!name) {
      const info = await slackGet<{ channel?: { name?: string } }>("conversations.info", { channel });
      name = info.channel?.name ?? channel;
      if (info.ok) state.slackChannelNames = { ...state.slackChannelNames, [channel]: name };
    }
    // Parents posted in the lookback window. Replies to an older parent are
    // missed; escalations that old are closed or pruned in practice.
    const parents: SlackMsg[] = [];
    let cursor = "";
    for (let page = 0; page < 5; page++) {
      const h = await slackGet<{ messages?: SlackMsg[]; response_metadata?: { next_cursor?: string } }>(
        "conversations.history",
        { channel, oldest, limit: "200", ...(cursor ? { cursor } : {}) },
      );
      if (!h.ok) {
        problems.push(
          h.error === "missing_scope"
            ? `#${name}: Jetta needs the channels:history (groups:history for private) scope.`
            : h.error === "not_in_channel"
              ? `#${name}: Jetta is not in this channel.`
              : `#${name}: Slack said ${h.error}`,
        );
        break;
      }
      parents.push(...(h.messages ?? []));
      cursor = h.response_metadata?.next_cursor ?? "";
      if (!cursor) break;
    }

    const last = seen[channel] ?? "0";
    let newest = last;
    let reads = 0;
    // Oldest movement first, so a run cut short by the read budget resumes
    // where it stopped instead of skipping the threads it never got to.
    const moving = parents
      .map((p) => ({ p, moved: p.latest_reply ?? p.ts }))
      .filter(({ moved }) => Number(moved) > Number(last))
      .sort((a, b) => Number(a.moved) - Number(b.moved));
    let cutShort = false;
    for (const { p, moved } of moving) {
      let replies: SlackMsg[] = [];
      if (p.reply_count) {
        if (reads >= SLACK_THREADS_PER_RUN) {
          cutShort = true;
          break;
        }
        reads++;
        const r = await slackGet<{ messages?: SlackMsg[] }>("conversations.replies", {
          channel,
          ts: p.ts,
          limit: "200",
        });
        if (r.ok) replies = r.messages ?? [];
      }
      acts.push(...activitiesFromSlackThread(channel, name, p, replies));
      if (Number(moved) > Number(newest)) newest = moved;
    }
    if (!cutShort || newest !== last) seen[channel] = newest;
  }
  state.slack = seen;
  await resolveSlackNames(acts);
  return { acts, problem: problems.join(" ") || undefined };
}

/** Name every Slack user we have rows for, once. Ids stay as-is if users:read is missing. */
async function resolveSlackNames(acts: Activity[]): Promise<void> {
  const known = await getSlackNames();
  const ids = [...new Set(acts.map((a) => a.who.replace(/^slack:/, "")))].filter((id) => !known[id]);
  const found: Record<string, string> = {};
  for (const id of ids.slice(0, 40)) {
    const u = await slackGet<{ user?: { real_name?: string; name?: string; profile?: { display_name?: string; real_name?: string } } }>(
      "users.info",
      { user: id },
    );
    if (!u.ok) break;
    const n = u.user?.profile?.real_name || u.user?.real_name || u.user?.profile?.display_name || u.user?.name;
    if (n) found[id] = n;
  }
  await saveSlackNames(found);
}

// ── monday ──────────────────────────────────────────────────────────

async function mondayGql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: {
      Authorization: config.monday.apiToken ?? "",
      "Content-Type": "application/json",
      "API-Version": "2024-10",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(`monday: ${json.errors.map((e) => e.message).join("; ")}`);
  if (!json.data) throw new Error("monday returned no data");
  return json.data;
}

/**
 * Jetta posts to monday with an API token that belongs to a person. That
 * person's own work still counts; what's dropped is what only Jetta does —
 * creating items and posting the "Product: / Account: / Freshdesk ticket:"
 * context block.
 */
const isJettaPost = (text: string | null) => /^\s*Product:/.test(text ?? "");

async function readMonday(state: ActivitySyncState): Promise<{ acts: Activity[]; problem?: string }> {
  if (!config.monday.live || !config.monday.apiToken) {
    return { acts: [], problem: "monday is not connected in this environment." };
  }
  const boardIds = [...new Set(Object.values(config.monday.boardIds).filter(Boolean) as string[])];
  if (!boardIds.length) return { acts: [], problem: "No dev boards configured." };

  const runStart = new Date().toISOString();
  const from = state.mondayFrom ?? new Date(Date.now() - MONDAY_BACKFILL_DAYS * 86_400_000).toISOString();
  const fromMs = Date.parse(from);

  const head = await mondayGql<{
    me: { id: string; name: string };
    users: { id: string; name: string }[];
    boards: { id: string; name: string; activity_logs: MondayLog[] | null }[];
  }>(
    `query($ids:[ID!],$from:ISO8601DateTime){
      me { id name }
      users(limit: 500) { id name }
      boards(ids: $ids) { id name activity_logs(from: $from, limit: 1000) { id event data user_id created_at } }
    }`,
    { ids: boardIds, from },
  );
  const users = await getMondayUsers();
  for (const u of head.users) users.set(String(u.id), u.name);
  await saveMondayUsers(users);
  const self = String(head.me.id);
  state.mondaySelf = { id: self, name: head.me.name };
  state.mondayBoards = Object.fromEntries(head.boards.map((b) => [String(b.id), b.name]));
  // What webhooks already delivered, so the safety-net read adds only what they missed.
  const pushed = (await loadActivities(fromMs - 120_000)).filter((a) => a.place === "monday");
  const accountUrl = config.monday.accountUrl;

  const acts: Activity[] = [];
  for (const b of head.boards) {
    const itemNames = new Map<string, string>();
    for (const log of b.activity_logs ?? []) {
      try {
        const d = JSON.parse(log.data) as { pulse_id?: number; pulse_name?: string };
        if (d.pulse_id && d.pulse_name) itemNames.set(String(d.pulse_id), d.pulse_name);
      } catch {
        // ignore — the row is skipped below too
      }
      if (String(log.user_id) === self && log.event === "create_pulse") continue;
      const act = activityFromMondayLog(log, b.id, b.name, users, accountUrl);
      if (act) acts.push(act);
    }

    for (let page = 1; page <= MONDAY_UPDATE_PAGES; page++) {
      const u = await mondayGql<{
        boards: { updates: (MondayUpdate & { item: { name: string } | null; replies: (MondayUpdate & { item_id?: null })[] })[] }[];
      }>(
        `query($ids:[ID!],$page:Int){ boards(ids: $ids) { updates(limit: 100, page: $page) {
          id created_at creator_id item_id text_body item { name }
          replies { id created_at creator_id text_body }
        } } }`,
        { ids: [b.id], page },
      );
      const updates = u.boards[0]?.updates ?? [];
      let reachedOld = false;
      for (const up of updates) {
        if (up.item_id && up.item?.name) itemNames.set(up.item_id, up.item.name);
        const all: MondayUpdate[] = [up, ...(up.replies ?? []).map((r) => ({ ...r, item_id: up.item_id }))];
        for (const x of all) {
          if (Date.parse(x.created_at) < fromMs) continue;
          if (String(x.creator_id) === self && isJettaPost(x.text_body)) continue;
          const act = activityFromMondayUpdate(x, b.id, users, accountUrl, itemNames);
          if (act) acts.push(act);
        }
        // Updates come newest first; a top-level update older than the window
        // means every later page is older still (replies were checked above).
        if (Date.parse(up.created_at) < fromMs) reachedOld = true;
      }
      if (reachedOld || updates.length < 100) break;
    }
  }
  // A little overlap: monday's log can land a few seconds after the action.
  state.mondayFrom = new Date(Date.parse(runStart) - 10 * 60_000).toISOString();
  const viaWebhook = pushed.filter((a) => a.id.startsWith("monw:") || a.id.startsWith("monu:"));
  const missing = acts.filter((a) => !viaWebhook.some((p) => sameMondayAction(p, a)));
  return { acts: missing };
}
