/**
 * Remove whatever the JettaChat test suites left behind.
 *
 * Both `chat-e2e.ts` and `chat-eval.ts` clean up after themselves. This exists
 * for the run that didn't finish: a crashed E2E pass, an interrupted eval, a
 * `--keep` run you have finished inspecting. It reads the same state files they
 * write, so it removes exactly what they created and nothing else.
 *
 *   npx tsx --env-file=.env.local scripts/chat-cleanup.ts
 *   npx tsx --env-file=.env.local scripts/chat-cleanup.ts --sweep
 *
 * --sweep additionally scans the conversation store for anything wearing a test
 * identity, which catches artifacts from a run whose state file was deleted.
 * It matches on the two addresses the suites use and nothing else, so a real
 * customer's transcript can never be caught by it.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Redis } from "@upstash/redis";

const SWEEP = process.argv.includes("--sweep");
const DRY = process.argv.includes("--dry");

/** The identities the suites create under. Nothing else is ever touched. */
const TEST_EMAILS = new Set(["jetta-e2e@jetpackwork.com", "jetta-eval@jetpackwork.com"]);

const E2E_MANIFEST = ".chat-eval/manifest.json";
const EVAL_RUNS = ".chat-eval/runs.json";
const EVAL_JUDGED = ".chat-eval/judged.json";

const read = <T,>(p: string, dflt: T): T =>
  existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : dflt;

async function main() {
  const redis =
    process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
      ? new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN })
      : null;

  const manifest = read<{ conversations: string[]; tickets: string[]; rateKeys: string[] }>(
    E2E_MANIFEST,
    { conversations: [], tickets: [], rateKeys: [] },
  );
  const runs = [
    ...read<{ conversationId?: string; ticketId?: string }[]>(EVAL_RUNS, []),
    ...read<{ conversationId?: string; ticketId?: string }[]>(EVAL_JUDGED, []),
  ];

  const conversations = new Set(
    [...manifest.conversations, ...runs.map((r) => r.conversationId)].filter(Boolean) as string[],
  );
  const tickets = new Set(
    [...manifest.tickets, ...runs.map((r) => r.ticketId)].filter(Boolean) as string[],
  );

  // A run whose state file was deleted leaves orphans that only the identity
  // can find.
  if (SWEEP && redis) {
    const ids = (await redis.zrange<string[]>("jetta:chats", 0, -1)) ?? [];
    for (const id of ids) {
      const conv = await redis.get<{ visitor?: { email?: string } }>(`jetta:chat:${id}`);
      // A dangling index entry with no document is itself litter.
      if (!conv) {
        if (!DRY) await redis.zrem("jetta:chats", id);
        console.log(`  index entry with no conversation: ${id}`);
        continue;
      }
      if (TEST_EMAILS.has((conv.visitor?.email ?? "").toLowerCase())) conversations.add(id);
    }
    console.log(`Swept ${ids.length} conversations in the store.`);
  }

  console.log(
    `${conversations.size} conversations, ${tickets.size} tickets, ${manifest.rateKeys.length} rate keys` +
      (DRY ? " (dry run — nothing removed)" : ""),
  );

  const domain = process.env.FRESHDESK_DOMAIN ?? "jetpackwork.freshdesk.com";
  const key = process.env.FRESHDESK_API_KEY;
  let ticketsGone = 0;
  for (const id of tickets) {
    if (DRY) continue;
    if (!key) {
      console.warn(`  ticket ${id}: no FRESHDESK_API_KEY, skipped`);
      continue;
    }
    const res = await fetch(`https://${domain}/api/v2/tickets/${id}`, {
      method: "DELETE",
      headers: { Authorization: "Basic " + Buffer.from(`${key}:X`).toString("base64") },
    });
    // 404 counts: the goal is "not there", not "deleted by me".
    if (res.ok || res.status === 404) ticketsGone++;
    else console.warn(`  ticket ${id}: HTTP ${res.status}`);
  }

  let convsGone = 0;
  if (redis && !DRY) {
    for (const id of conversations) {
      await redis.del(`jetta:chat:${id}`);
      await redis.zrem("jetta:chats", id);
      convsGone++;
    }
    for (const k of manifest.rateKeys) await redis.del(k);
  }

  if (!DRY) {
    writeFileSync(
      E2E_MANIFEST,
      JSON.stringify({ conversations: [], tickets: [], rateKeys: [], startedAt: new Date().toISOString() }, null, 1),
    );
  }

  console.log(
    `Removed ${convsGone}/${conversations.size} conversations and ${ticketsGone}/${tickets.size} tickets.`,
  );
  if (!DRY && existsSync(EVAL_RUNS)) {
    console.log(
      `Eval results in .chat-eval/ are kept — they are the baseline to compare the next run against.\n` +
        `The conversations behind them are gone, so re-running \`chat-eval.ts run\` needs a fresh .chat-eval/runs.json.`,
    );
  }
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.stack : e);
  process.exit(1);
});
