/**
 * One escalation thread per ticket.
 *
 * Jetta used to raise the same issue again on every customer reply: the Slack
 * post is never read back, the private note recording it is filtered out of the
 * replayed history, and the escalation triggers are standing conditions that
 * stay true forever. 31 of 104 live escalations between 4 Jul and 17 Aug were
 * repeats — #13900 was posted seven times. This pins the fix down.
 *
 *   npx tsx scripts/escalation-dedupe-test.ts
 */
// Stubbed on purpose: postMessage logs instead of sending, and the escalation
// store falls back to memory. The KV credentials are cleared rather than merely
// assumed absent — run with --env-file=.env.local this would otherwise write
// `jetta:escalation:13900` into the real store and point a live ticket's next
// escalation at a message that never existed.
export {};

process.env.STUB_MODE = "true";
delete process.env.SLACK_LIVE;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
process.env.SLACK_ESCALATION_CHANNEL = "#jetta-escalations";

let failures = 0;
/** Every stubbed post, as { thread, broadcast } plus the body. */
const posts: { thread: string | null; broadcast: boolean; head: string; body: string }[] = [];
const realLog = console.log;
const realWarn = console.warn;
console.log = (...args: unknown[]) => {
  const line = args.map(String).join(" ");
  if (!line.startsWith("[stub] slack →")) return realLog(...args);
  const [header, ...rest] = line.split("\n");
  const thread = /\(thread ([\d.]+)/.exec(header!)?.[1] ?? null;
  posts.push({
    thread,
    broadcast: header!.includes(", broadcast)"),
    head: rest[0] ?? "",
    body: rest.join("\n"),
  });
};
console.warn = () => {}; // the pruned-thread case logs a warning by design

function check(name: string, pass: boolean, detail?: string) {
  realLog(`${pass ? "  ok  " : "FAIL  "}${name}${!pass && detail ? ` — ${detail}` : ""}`);
  if (!pass) failures++;
}

const escalation = (n: number) => ({
  ticketId: "13900",
  freshdeskTicketUrl: "https://jetpackwork.freshdesk.com/a/tickets/13900",
  userAccountUrl: "https://thewild6.monday.com",
  headline: `Copy & Sync recipe setup fails — report ${n}`,
  app: "vlookup",
  accountLabel: "laura@thewild6.com",
  ticketRef: "#13900",
  summary: `Context from run ${n}.`,
  alreadyTried: "Searched KB — nothing matched",
  question: `Question from run ${n}?`,
});

async function main() {
  const slack = await import("../lib/tools/slack");
  const kv = await import("../lib/kv");

  // ── The first escalation opens a thread ──
  posts.length = 0;
  const first = await slack.sendEscalation(escalation(1));
  check("first escalation is a new post", first.updated === false);
  check("first escalation posts a parent + detail reply", posts.length === 2, `${posts.length} posts`);
  check("parent is top-level", posts[0]?.thread === null);
  check("detail is threaded under the parent", posts[1]?.thread === first.ts);
  check(
    "the thread is remembered for the ticket",
    (await kv.getEscalationTs("13900")) === first.ts,
  );

  // ── A second run updates it instead of raising a second issue ──
  posts.length = 0;
  const second = await slack.sendEscalation(escalation(2));
  check("second escalation is an update", second.updated === true);
  check("second escalation reuses the first thread", second.ts === first.ts);
  check("second escalation posts exactly once", posts.length === 1, `${posts.length} posts`);
  check("the update is threaded, never top-level", posts[0]?.thread === first.ts);
  check("the update is labelled as one", posts[0]?.head.includes("Update —") === true, posts[0]?.head);
  check("the update carries the new context", posts[0]?.body.includes("Context from run 2.") === true);
  check(
    "the update carries the new question",
    posts[0]?.body.includes("Question from run 2?") === true,
  );
  check("a normal update stays in the thread", posts[0]?.broadcast === false);

  // ── An urgent update is announced in the channel as well ──
  // A thread reply only reaches people already following it, and "customer is
  // on a call right now" cannot depend on who happened to open the thread.
  posts.length = 0;
  const urgent = await slack.sendEscalation({ ...escalation(3), urgent: true });
  check("an urgent follow-up is still an update", urgent.updated === true && urgent.ts === first.ts);
  check("an urgent follow-up is still one post", posts.length === 1, `${posts.length} posts`);
  check("an urgent follow-up is broadcast to the channel", posts[0]?.broadcast === true);
  check("it stays attached to the thread", posts[0]?.thread === first.ts);
  check("and says it is urgent", posts[0]?.head.includes("Urgent update —") === true, posts[0]?.head);

  // ── A different ticket is still its own escalation ──
  posts.length = 0;
  const other = await slack.sendEscalation({ ...escalation(4), ticketId: "13955", ticketRef: "#13955" });
  check("a different ticket gets its own thread", other.updated === false && other.ts !== first.ts);
  check("and its own parent post", posts[0]?.thread === null);

  // ── A pruned thread falls back to a fresh escalation ──
  // The team clears this channel as issues close — 270 messages in one sweep on
  // 15 Aug — so a remembered ts routinely points at a message that is gone.
  posts.length = 0;
  const live = await import("../lib/config");
  const original = live.config.slack.live;
  try {
    // Force the live path so postMessage really calls Slack, with a fetch that
    // answers the way Slack does for a deleted parent.
    (live.config.slack as { live: boolean }).live = true;
    const realFetch = globalThis.fetch;
    const sent: { thread_ts?: string; reply_broadcast?: boolean }[] = [];
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { thread_ts?: string; reply_broadcast?: boolean };
      sent.push(body);
      const ok = body.thread_ts !== first.ts; // only the pruned parent is missing
      return {
        json: async () => (ok ? { ok: true, ts: "1799999999.000100" } : { ok: false, error: "thread_not_found" }),
      };
    }) as unknown as typeof fetch;

    // Urgent on purpose: the fallback has to survive the noisier path too.
    const revived = await slack.sendEscalation({ ...escalation(5), urgent: true });
    check("a pruned thread does not swallow the escalation", revived.updated === false);
    check("it becomes a new parent instead", revived.ts === "1799999999.000100");
    check("the failed update is retried as a real post", sent.length === 3, `${sent.length} slack calls`);
    check(
      "the new thread replaces the dead one",
      (await kv.getEscalationTs("13900")) === "1799999999.000100",
    );
    // Slack rejects reply_broadcast without a thread_ts, so an urgent
    // escalation that ends up top-level must not carry it.
    check(
      "a top-level post never asks to be broadcast",
      sent.every((b) => b.thread_ts !== undefined || b.reply_broadcast === undefined),
      JSON.stringify(sent.map((b) => ({ t: b.thread_ts, b: b.reply_broadcast }))),
    );
    globalThis.fetch = realFetch;
  } finally {
    (live.config.slack as { live: boolean }).live = original;
  }

  // ── A ts must survive the store exactly ──
  // Slack ts values are all digits and a dot, so a store that JSON-parses what
  // it reads back turns "…536630" into the number …53663 and loses the trailing
  // zero — one shape in ten. A ts off by one digit fails to thread and posts a
  // duplicate parent, which is the whole bug. (The Upstash path is the one that
  // actually did this; it is verified against real KV, not here.)
  await kv.recordEscalation("trailing-zero", "1786969784.536630");
  const roundTripped = await kv.getEscalationTs("trailing-zero");
  check("a ts keeps its trailing zero", roundTripped === "1786969784.536630", String(roundTripped));
  check("a ts comes back as a string", typeof roundTripped === "string", typeof roundTripped);
  await kv.clearEscalation("trailing-zero");

  // ── Resolving the ticket closes the thread ──
  await kv.clearEscalation("13900");
  check("a resolved ticket forgets its escalation", (await kv.getEscalationTs("13900")) === null);

  // ── No ticket id: unchanged behaviour, never threads onto someone else ──
  posts.length = 0;
  const anon = await slack.sendEscalation({ ...escalation(6), ticketId: undefined });
  check("an escalation with no ticket still posts", anon.updated === false && posts.length === 2);

  console.log = realLog;
  console.warn = realWarn;
  realLog(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.log = realLog;
  console.error("ERROR:", e instanceof Error ? e.stack : e);
  process.exit(1);
});
