/**
 * Re-link monday ids in escalations Jetta already posted.
 *
 *   npx tsx --env-file=.env.local scripts/slack-relink.ts <ts> [<ts> …] [--commit]
 *   npx tsx --env-file=.env.local scripts/slack-relink.ts <threads.json> [--commit]
 *
 * DRY RUN BY DEFAULT — prints a before/after diff and writes nothing.
 *
 * Given message timestamps it reads the threads itself, which needs
 * groups:history on Jetta's bot token (chat:write alone lets her edit her own
 * posts in a private channel without being able to read them back). Without
 * that scope it says so and stops.
 *
 * The file form is the fallback for exactly that case: capture the originals
 * with a client that can read, as
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
// Guard the -1: without the flag, `flagIndex + 1` is 0 and would silently
// swallow the first positional argument.
const channelValueIdx = flagIndex >= 0 ? flagIndex + 1 : -1;
const files = args.filter((a, i) => !a.startsWith("--") && i !== channelValueIdx);

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
  if (!files.length) throw new Error("pass message timestamps, or one threads.json path");

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

  // Timestamps → read the threads ourselves. A .json path → use the text in it.
  const fromFile = files.length === 1 && files[0].endsWith(".json");
  let threads: Msg[][];
  if (fromFile) {
    threads = JSON.parse(readFileSync(files[0], "utf8")) as Msg[][];
    console.log(`reading ${threads.length} thread(s) from ${files[0]}`);
  } else {
    threads = [];
    for (const ts of files) {
      try {
        let messages: Msg[];
        try {
          const r = await slack<{ messages: Msg[] }>("conversations.replies", { channel: channelId, ts });
          messages = r.messages;
        } catch (e) {
          // Escalations posted before the parent+thread split have no replies,
          // and conversations.replies rejects a ts that isn't part of a thread.
          if (!(e instanceof Error) || !e.message.includes("invalid_arguments")) throw e;
          const r = await slack<{ messages: Msg[] }>("conversations.history", {
            channel: channelId,
            latest: ts,
            oldest: ts,
            inclusive: true,
            limit: 1,
          });
          messages = r.messages;
        }
        if (!messages.length) {
          console.log(`\n${ts}: no message found — skipping`);
          continue;
        }
        threads.push(messages);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("missing_scope")) {
          throw new Error(
            "Jetta's token cannot read this channel — add the groups:history bot scope at " +
              "api.slack.com/apps → OAuth & Permissions, then reinstall the app. " +
              "Until then, capture the text elsewhere and pass a threads.json instead.",
          );
        }
        throw e;
      }
    }
  }

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
