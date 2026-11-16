/**
 * Two crons that kept reporting "ok" while doing nothing — checked without a
 * network or a model.
 *
 *   npx tsx scripts/cron-reliability-test.ts
 *
 * The chat follow-up read "everything idle", oldest first, capped at 200. Old
 * resolved chats stay in the index for the retention window, so once there
 * were more than 200 of them the cap was full before any recent chat was
 * reached: no nudges, no 24-hour resolve, no pickup of an unanswered hand-off.
 *
 * The error watch marked an issue "decided" for 30 days before deciding
 * anything, so an issue that met the daily cap was never filed.
 */
export {};

// Before ANY import: lib/config.ts snapshots process.env on first load.
process.env.STUB_MODE = "true";
process.env.JETTACHAT_LIVE = "true";
process.env.JETTACHAT_SECRET = "cron-test-secret-do-not-use-in-prod";
for (const v of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_URL", "DATABASE_URL"]) {
  delete process.env[v];
}

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${!ok && detail ? `\n        ${detail}` : ""}`);
}
const section = (name: string) => console.log(`\n── ${name} ──`);

async function main() {
  const store = await import("../lib/chat-store");
  const { config } = await import("../lib/config");
  const DAY = 86_400_000;
  const MIN = 60_000;

  section("Which idle chats the sweep reads");
  const now = Date.parse("2026-11-16T12:00:00Z");
  const cutoff = now - 15 * MIN;
  const old = Array.from({ length: 300 }, (_, i) => ({ id: `old-${i}`, at: now - (2 + i * 0.03) * DAY }));
  const recent = [
    { id: "quiet-20m", at: now - 20 * MIN },
    { id: "quiet-3h", at: now - 180 * MIN },
  ];
  const picked = store.pickIdle([...old, ...recent], cutoff, 200);
  check("a chat that went quiet 20 minutes ago is read, behind 300 older ones", picked.some((e) => e.id === "quiet-20m"));
  check("…and it is read first", picked[0]?.id === "quiet-20m", picked[0]?.id);
  check("the cap still holds", picked.length === 200, String(picked.length));
  check("a chat still active is not a candidate", !store.pickIdle([{ id: "active", at: now - 2 * MIN }], cutoff, 200).length);
  check(
    "nothing older than the window is read at all",
    !store.pickIdle([{ id: "ancient", at: cutoff - (store.IDLE_WINDOW_DAYS + 1) * DAY }], cutoff, 200).length,
  );
  check(
    "…and the window is far wider than anything the sweep acts on (a day)",
    store.pickIdle([{ id: "day-old", at: now - 26 * 60 * MIN }], cutoff, 200).length === 1 && store.IDLE_WINDOW_DAYS >= 7,
  );

  // The same through the store, in memory.
  const made: string[] = [];
  for (let i = 0; i < 3; i++) {
    const c = await store.createConversation({ surface: "wordpress", visitor: {} });
    await store.appendMessage(c.id, "visitor", `hello ${i}`);
    made.push(c.id);
  }
  const idle = await store.listIdleSince(Date.now() + MIN, 2);
  check("the store returns the most recently idle, capped", idle.length === 2 && idle.every((c) => made.includes(c.id)), idle.map((c) => c.id).join());
  check("a conversation with newer activity than the cutoff is left out", (await store.listIdleSince(Date.now() - 60 * MIN, 10)).length === 0);

  section("Error watch: an issue that met the daily cap is tried again");
  const watch = await import("../lib/error-watch");
  const { rateCount } = await import("../lib/kv");
  (config as unknown as { errorWatch: { devItems: string } }).errorWatch.devItems = "on";
  const today = new Date().toISOString().slice(0, 10);
  await rateCount(`errorwatch:devitems:${today}`, 2 * 86_400);
  await rateCount(`errorwatch:devitems:${today}`, 2 * 86_400);
  const issue = {
    id: "issue-1",
    shortId: "JETTA-1",
    app: "vlookup",
    title: "TypeError: cannot read properties of undefined",
    link: "https://sentry.example/issue-1",
    accountsDistinct: 3,
    users: 12,
    flags: ["new"],
    events24h: 40,
    baseline: 0,
    firstSeen: "2026-11-16T00:00:00Z",
    lastSeen: "2026-11-16T11:00:00Z",
    daily: [],
  } as never;
  const first = await watch.maybeFileDevItem(issue);
  check("at the cap, the issue is reported as skipped", /daily cap/.test(first?.skipped ?? ""), JSON.stringify(first));
  const second = await watch.maybeFileDevItem(issue);
  check(
    "…and it is still a candidate on the next run, not silenced for 30 days",
    /daily cap/.test(second?.skipped ?? ""),
    `second run returned ${JSON.stringify(second)}`,
  );
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} FAILED` : "\nall passed");
    process.exit(failures ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
