/**
 * One-off backfill: stamp the app onto chat conversations that were held
 * before the run started doing it.
 *
 * The console can now filter chats per app, but the field it filters on only
 * arrived with `lib/chat-run.ts` stamping `ctx.app` — so every earlier
 * conversation reads "Not attributed" unless its embed happened to pass
 * `data-app`, which only the GetSign and monday snippets do. The answer is
 * already on disk: each chat turn wrote an outcome event keyed by the
 * conversation id, carrying the app triage worked out at the time. This copies
 * it back onto the conversation.
 *
 * DRY RUN BY DEFAULT — prints what it would stamp and writes nothing.
 *
 *   npx tsx --env-file=.env.local scripts/backfill-chat-apps.ts
 *   npx tsx --env-file=.env.local scripts/backfill-chat-apps.ts --commit
 *
 * Safe to re-run: conversations that already carry an app are left alone, and
 * "unknown" is never written — an outcome that could not tell which app it was
 * has nothing to teach the conversation.
 */
import { getOutcomes } from "../lib/kv";
import { listConversations, updateConversation } from "../lib/chat-store";
import { appName, type AppProduct } from "../lib/types";

const COMMIT = process.argv.includes("--commit");

async function main() {
  const [conversations, outcomes] = await Promise.all([listConversations(500), getOutcomes(1000)]);

  // Newest outcome per conversation wins: later turns saw more of the
  // conversation than the first one did.
  const byConversation = new Map<string, string>();
  for (const o of outcomes) {
    if (o.channel !== "jettachat" || !o.app || o.app === "unknown") continue;
    if (!byConversation.has(o.ticketId)) byConversation.set(o.ticketId, o.app);
  }

  const todo = conversations
    .filter((c) => !c.app && !c.visitor.app)
    .map((c) => ({ c, app: byConversation.get(c.id) }))
    .filter((r): r is { c: (typeof conversations)[number]; app: string } => !!r.app);

  const already = conversations.filter((c) => c.app || c.visitor.app).length;
  const stillBlank = conversations.length - already - todo.length;

  console.log(
    `${conversations.length} conversations — ${already} already attributed, ${todo.length} to stamp, ${stillBlank} with no outcome to learn from.\n`,
  );

  const counts = new Map<string, number>();
  for (const { app } of todo) counts.set(app, (counts.get(app) ?? 0) + 1);
  for (const [app, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${appName(app)}`);
  }

  if (!COMMIT) {
    console.log(`\nDry run — nothing written. Re-run with --commit.`);
    return;
  }

  let written = 0;
  for (const { c, app } of todo) {
    await updateConversation(c.id, { app: app as AppProduct });
    written++;
  }
  console.log(`\nStamped ${written} conversation${written === 1 ? "" : "s"}.`);
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
