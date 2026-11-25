/**
 * The chat must not read Redis for nobody.
 *
 * In November 2026 Jetta made about 40 million Redis reads a month: a live
 * stream held for every open page (two reads every 1.5 seconds, panel closed
 * or tab hidden), and a console that listed 100 conversations with 101 reads
 * every 10 to 20 seconds. This pins what replaced it.
 *
 *   npx tsx scripts/chat-polling-load-test.ts
 */
import assert from "node:assert/strict";

// Before ANY import: lib/config.ts snapshots process.env on first load.
process.env.STUB_MODE = "true";
process.env.JETTACHAT_LIVE = "true";
process.env.JETTACHAT_SECRET = "polling-load-test-secret-do-not-use-in-prod";
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]) {
  delete process.env[k];
}

async function main() {
  const pace = await import("../lib/chat-stream-pace");
  const store = await import("../lib/chat-store");
  const { NextRequest } = await import("next/server");
  const { GET } = await import("../app/api/chat/stream/route");

  // ── 1. Pace ──
  assert.equal(pace.streamPollMs({ typing: true, msSinceLastMessage: null }), pace.STREAM_ACTIVE_MS, "typing: fast");
  assert.equal(pace.streamPollMs({ typing: false, msSinceLastMessage: 5_000 }), pace.STREAM_ACTIVE_MS, "just spoke: fast");
  assert.equal(pace.streamPollMs({ typing: false, msSinceLastMessage: pace.STREAM_ACTIVE_WINDOW_MS }), pace.STREAM_IDLE_MS, "quiet: slow");
  assert.equal(pace.streamPollMs({ typing: false, msSinceLastMessage: null }), pace.STREAM_IDLE_MS, "no messages: slow");
  assert.ok(pace.STREAM_IDLE_MS >= 2 * pace.STREAM_ACTIVE_MS);

  assert.equal(pace.chatInView({ panelOpen: true, tabVisible: true }), true);
  assert.equal(pace.chatInView({ panelOpen: false, tabVisible: true }), false, "panel closed: no live stream");
  assert.equal(pace.chatInView({ panelOpen: true, tabVisible: false }), false, "tab in the background: no live stream");

  assert.equal(pace.backgroundCheckMs({ lastAuthor: "visitor", msSinceLastMessage: 20_000 }), pace.BACKGROUND_WAITING_MS, "waiting on an answer: sooner");
  assert.equal(pace.backgroundCheckMs({ lastAuthor: "visitor", msSinceLastMessage: pace.WAITING_WINDOW_MS }), pace.BACKGROUND_QUIET_MS, "waited too long to count");
  assert.equal(pace.backgroundCheckMs({ lastAuthor: "agent", msSinceLastMessage: 1_000 }), pace.BACKGROUND_QUIET_MS, "answered: quiet");
  assert.equal(pace.backgroundCheckMs({ lastAuthor: undefined, msSinceLastMessage: null }), pace.BACKGROUND_QUIET_MS);
  assert.ok(pace.BACKGROUND_WAITING_MS > pace.STREAM_IDLE_MS, "a background check is always rarer than the stream");

  // ── 2. Listing 100 conversations is a handful of reads, in order ──
  const calls: string[][] = [];
  const fake = {
    mget: async (...keys: string[]) => {
      calls.push(keys);
      return keys.map((k) => (k.endsWith(":gone") ? null : { id: k.replace("jetta:chat:", "") }));
    },
  } as unknown as Parameters<typeof store.readConversations>[0];
  const ids = Array.from({ length: 100 }, (_, i) => (i === 37 ? "gone" : `c${i}`));
  const rows = await store.readConversations(fake, ids);
  assert.equal(calls.length, Math.ceil(100 / store.LIST_BATCH), "one MGET per batch, not one GET per conversation");
  assert.ok(calls.length <= 5);
  assert.equal(rows.length, 100);
  assert.deepEqual(rows.map((r) => r?.id ?? null), ids.map((id) => (id === "gone" ? null : id)), "order follows the ids; a missing one is null");
  assert.ok(calls.every((c) => c.every((k) => k.startsWith("jetta:chat:"))));
  calls.length = 0;
  assert.deepEqual(await store.readConversations(fake, []), []);
  assert.equal(calls.length, 0, "nothing to read, nothing read");

  // ── 3. One snapshot carries the conversation and the typing flag ──
  const conv = await store.createConversation({ surface: "unknown", visitor: {} });
  const first = await store.appendMessage(conv.id, "visitor", "hello");
  assert.ok(first);
  let snap = await store.streamSnapshot(conv.id);
  assert.equal(snap.conversation?.id, conv.id);
  assert.equal(snap.typing, false);
  await store.markRunActive(conv.id);
  snap = await store.streamSnapshot(conv.id);
  assert.equal(snap.typing, true);
  await store.clearRunActive(conv.id);
  assert.deepEqual(await store.streamSnapshot("no-such-conversation"), { conversation: null, typing: false });

  // ── 4. The one-look answer the widget asks for out of view ──
  const token = store.signToken(conv.id);
  const peek = async (after: string | null, c = conv.id, t = token) => {
    const q = new URLSearchParams({ c, token: t, peek: "1" });
    if (after) q.set("after", after);
    return GET(new NextRequest(`https://jetta.test/api/chat/stream?${q}`));
  };

  const res = await peek(first.id);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/, "a look is JSON, not a held-open stream");
  assert.deepEqual(await res.json(), { messages: [], typing: false, status: "open" }, "nothing new");

  const reply = await store.appendMessage(conv.id, "agent", "hi there");
  assert.ok(reply);
  await store.markRunActive(conv.id);
  let body = (await (await peek(first.id)).json()) as { messages: { id: string }[]; typing: boolean };
  assert.deepEqual(body.messages.map((m) => m.id), [reply.id], "only what came after the cursor");
  assert.equal(body.typing, true);
  await store.clearRunActive(conv.id);

  body = (await (await peek("none")).json()) as typeof body;
  assert.deepEqual(body.messages.map((m) => m.id), [first.id, reply.id], "an unknown cursor replays everything");
  body = (await (await peek(null)).json()) as typeof body;
  assert.deepEqual(body.messages, [], "no cursor starts from now, as the stream does");

  assert.equal((await peek(first.id, conv.id, "wrong")).status, 403, "a look needs the conversation's token too");

  // ── 5. The stream still streams when the chat IS in view ──
  const q = new URLSearchParams({ c: conv.id, token, after: first.id });
  const live = await GET(new NextRequest(`https://jetta.test/api/chat/stream?${q}`));
  assert.match(live.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = live.body!.getReader();
  const { value } = await reader.read();
  assert.match(new TextDecoder().decode(value), new RegExp(`event: message[\\s\\S]*${reply.id}`), "the replay arrives first");
  await reader.cancel();

  console.log("chat-polling-load-test: all assertions passed");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
