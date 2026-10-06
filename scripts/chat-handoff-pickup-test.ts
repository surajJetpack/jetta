/**
 * Handoffs nobody answers must come back to Jetta even when the visitor says
 * nothing more (2026-09-22 → 10-05: four handoffs, no person joined, three
 * stranded until a colleague resolved them next day). In-memory, no model:
 *
 *   env -i PATH="$PATH" HOME="$HOME" STUB_MODE=true JETTACHAT_SECRET=t npx tsx scripts/chat-handoff-pickup-test.ts
 */
import assert from "node:assert/strict";
import { handoffPickupAction, pickUpHandoff, HANDOFF_STALE_MS } from "../lib/chat-run";
import * as store from "../lib/chat-store";
import type { ChatMessage } from "../lib/types";
import { getChatSettings } from "../lib/chat-settings";

const MIN = 60_000;
const now = Date.parse("2026-10-05T16:00:00Z");
const msg = (author: "visitor" | "agent", at: number): ChatMessage =>
  ({ id: String(at), author, text: "x", createdAt: new Date(at).toISOString() }) as ChatMessage;

const waiting = (requestedAgo: number, lastVisitorAgo: number) => ({
  status: "waiting_human" as const,
  humanRequestedAt: now - requestedAgo,
  messages: [msg("visitor", now - lastVisitorAgo), msg("agent", now - requestedAgo)],
});

// 4896681d: asked at 15:53, "cheers" 13s later, then silence.
assert.equal(handoffPickupAction(waiting(30_000, 17_000), now, 1), "wait", "inside the timeout");
assert.equal(handoffPickupAction(waiting(2 * MIN, 107_000), now, 1), "pick_up", "silent visitor past the timeout");
assert.equal(handoffPickupAction(waiting(2 * MIN, 10_000), now, 1), "in_flight", "visitor just wrote — their run decides");
assert.equal(handoffPickupAction(waiting(HANDOFF_STALE_MS, HANDOFF_STALE_MS), now, 1), "stale");
assert.equal(handoffPickupAction({ ...waiting(5 * MIN, 5 * MIN), status: "open" }, now, 1), "not_waiting");
assert.equal(handoffPickupAction(waiting(5 * MIN, 5 * MIN), now, 10), "wait", "respects a longer console timeout");

async function main() {
  // endHandoff is compare-and-set: exactly one caller wins.
  const c = await store.createConversation({ surface: "wordpress", visitor: { name: "V", email: "v@example.com" } } as never);
  await store.appendMessage(c.id, "visitor", "need a human rep please");
  await store.updateConversation(c.id, { status: "waiting_human", humanRequestedAt: Date.now() - 3 * HANDOFF_STALE_MS });
  const before = (await store.getConversation(c.id))!.lastActivityAt;

  // Stale: ended quietly — no apology the next morning, no activity bump.
  assert.equal(await pickUpHandoff(c.id, "cron"), "expired");
  const after = (await store.getConversation(c.id))!;
  assert.equal(after.status, "open");
  assert.equal(after.lastActivityAt, before, "a quiet expiry is not activity");
  assert.equal(after.messages.length, 1, "nothing said to a visitor long gone");

  // Second caller loses.
  assert.equal(await store.endHandoff(c.id, { touch: true }), false);
  assert.equal(await pickUpHandoff(c.id, "timer"), "not_waiting");

  // A ticketed conversation goes back to ticketed, not open.
  const t = await store.createConversation({ surface: "wordpress", visitor: { name: "W", email: "w@example.com" } } as never);
  await store.appendMessage(t.id, "visitor", "hello");
  await store.updateConversation(t.id, { status: "waiting_human", humanRequestedAt: Date.now() - MIN, ticketId: "14500" } as never);
  assert.equal(await store.endHandoff(t.id, { touch: true }), true);
  assert.equal((await store.getConversation(t.id))!.status, "ticketed");

  // The silent visitor, end to end on the timer path: call 1 → call 2 → ticket.
  assert.equal((await getChatSettings()).handoffAttempts, 2, "two calls by default");
  const q = await store.createConversation({ surface: "wordpress", visitor: { name: "Nir", email: "nir@example.com" } } as never);
  await store.appendMessage(q.id, "visitor", "hey need a human rep please");
  await store.updateConversation(q.id, { status: "waiting_human", humanRequestedAt: Date.now() - 2 * MIN, handoffPings: 1 });
  // appendMessage stamped "now"; age the visitor's message past the in-flight window.
  (await store.getConversation(q.id))!.messages[0].createdAt = new Date(Date.now() - 2 * MIN).toISOString();
  assert.equal(await pickUpHandoff(q.id, "timer"), "repinged");
  let qc = (await store.getConversation(q.id))!;
  assert.equal(qc.status, "waiting_human");
  assert.equal(qc.handoffPings, 2);
  assert.match(qc.messages.at(-1)!.text, /still trying/i);
  // Two racing callers can't both send the second call.
  assert.equal(await store.repingHandoff(q.id, 1), false);

  await store.updateConversation(q.id, { humanRequestedAt: Date.now() - 2 * MIN });
  assert.equal(await pickUpHandoff(q.id, "cron"), "ticketed");
  qc = (await store.getConversation(q.id))!;
  assert.equal(qc.status, "ticketed");
  assert.ok(qc.ticketId);
  assert.match(qc.messages.at(-1)!.text, new RegExp(`opened ticket #${qc.ticketId}.*nir@example\\.com`));
  assert.equal(qc.messages.length, 3, "visitor ask, still trying, ticket — no model turn needed");

  console.log("chat-handoff-pickup-test: all assertions passed");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
