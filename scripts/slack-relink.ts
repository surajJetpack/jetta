/**
 * Re-link monday ids in escalations Jetta already posted.
 *
 *   npx tsx --env-file=.env.local scripts/slack-relink.ts <threads.json> --channel C0… [--commit]
 *
 * DRY RUN BY DEFAULT — prints a before/after diff and writes nothing.
 *
 * The message text is supplied in a file rather than fetched: Jetta's bot token
 * carries chat:write but not groups:history, so she can edit her own posts in a
 * private channel without being able to read them back. Capture the originals
 * with a client that can read, as:
 *   [ [ {"ts": "…", "text": "…"}, …thread… ], …more threads… ]
 *
 * Edits in place via chat.update rather than delete-and-repost: the thread
 * replies hang off the parent's ts, and `@Jetta draft kb` reads whole threads,
 * so reposting would orphan the detail and change what the KB drafter sees.
 * Only Jetta's own messages can be edited this way, which is exactly the set
 * we want to touch.
 *
 * The parent and its thread reply are linkified together, because the account
 * URL that makes a customer board id resolvable usually sits in the thread
 * while the id itself sits in the parent — the same reason sendEscalation
 * resolves the account across the whole escalation rather than per field.
 */
import { linkifyMondayIds } from "../lib/tools/slack";
import { boardIdFor } from "../lib/tools/monday";
import { readFileSync } from "node:fs";
import { config } from "../lib/config";

const args = process.argv.slice(2);
const commit = args.includes("--commit");
const flagIndex = args.indexOf("--channel");
const files = args.filter((a, i) => !a.startsWith("--") && i !== flagIndex + 1);

const CHANNEL = config.slack.escalationChannel ?? "#jetta-escalations";

async function slack<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.slack.botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; error?: string } & T;
  if (!json.ok) throw new Error(`${method} failed: ${json.error}`);
  return json;
}

interface Msg {
  ts: string;
  text: string;
  user?: string;
  bot_id?: string;
  thread_ts?: string;
}

function show(label: string, before: string, after: string) {
  const changed = before !== after;
  console.log(`\n  ── ${label} ${changed ? "" : "(unchanged)"}`);
  if (!changed) return;
  for (const line of after.split("\n")) {
    const wasDifferent = !before.includes(line);
    if (wasDifferent) console.log(`     + ${line}`);
  }
}

async function main() {
  if (!config.slack.botToken) throw new Error("SLACK_BOT_TOKEN not set");
  if (files.length !== 1) throw new Error("pass exactly one threads.json path");
  const threads = JSON.parse(readFileSync(files[0], "utf8")) as Msg[][];

  // chat.update needs a channel id. Accept one directly (--channel C…, or a
  // config value that is already an id) and only fall back to a name lookup,
  // which needs groups:read and so fails for private channels.
  const flagIdx = args.indexOf("--channel");
  const explicit = flagIdx >= 0 ? args[flagIdx + 1] : undefined;
  let channelId = explicit ?? (/^[CG][A-Z0-9]+$/.test(CHANNEL) ? CHANNEL : undefined);
  if (!channelId) {
    const list = await slack<{ channels: { id: string; name: string }[] }>("conversations.list", {
      types: "public_channel,private_channel",
      limit: 1000,
    });
    const name = CHANNEL.replace(/^#/, "");
    channelId = list.channels.find((c) => c.name === name)?.id;
  }
  if (!channelId) {
    throw new Error(`could not resolve ${CHANNEL} to a channel id — pass --channel C0…`);
  }

  const devBoardId = boardIdFor("jetpackapps");
  console.log(`channel ${CHANNEL} (${channelId}) · dev board ${devBoardId} · ${commit ? "COMMIT" : "DRY RUN"}`);

  let edited = 0;
  for (const thread of threads) {
    // Account context spans the whole escalation: the parent carries the board
    // id, the thread reply usually carries the account URL that resolves it.
    const context = thread.map((m) => m.text).join("\n");
    console.log(`\n${thread[0]?.ts} — ${thread.length} message(s) in thread`);

    for (const m of thread) {
      const linked = linkifyMondayIds(m.text, { devBoardId, accountUrl: context });
      show(m.ts === thread[0].ts ? "parent" : `reply ${m.ts}`, m.text, linked);
      if (linked === m.text) continue;
      edited++;
      if (!commit) continue;
      await slack("chat.update", { channel: channelId, ts: m.ts, text: linked });
      console.log(`     ✓ updated ${m.ts}`);
    }
  }

  console.log(
    commit ? `\nCOMMITTED — ${edited} message(s) edited.\n` : `\nDRY RUN — ${edited} message(s) would change. Re-run with --commit.\n`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
