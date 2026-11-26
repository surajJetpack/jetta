/**
 * The Today page must degrade, not die, when Jetta's ticket copy is down.
 *
 * In November 2026 the copy's database was over quota. The page fell back to
 * Freshdesk for every ticket at once, was refused (40 calls a minute), waited
 * on retries and timed out at 60 seconds with nothing to show.
 *
 *   npx tsx scripts/today-degrade-test.ts
 */
import assert from "node:assert/strict";

process.env.STUB_MODE = "true";

/** A thread state with no message times: these tests are about who answers, not when. */
const st = (status: string | null, awaitingReply: boolean) => ({ status, awaitingReply, lastCustomerAt: null, lastAgentAt: null });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { boundedLookups } = await import("../lib/bounded-lookups");
  const today = await import("../lib/today");
  const { INSIGHT_TIMEOUT_MS } = await import("../lib/today-insight");

  // ── 1. A few at a time ──
  let running = 0;
  let peak = 0;
  const ids = Array.from({ length: 12 }, (_, i) => String(i));
  const all = await boundedLookups(
    ids,
    async (id) => {
      running++;
      peak = Math.max(peak, running);
      await sleep(10);
      running--;
      return `v${id}`;
    },
    { concurrency: 3, budgetMs: 5_000 },
  );
  assert.equal(peak, 3, "never more than the limit at once");
  assert.equal(all.results.size, 12);
  assert.deepEqual(all.unchecked, []);
  assert.equal(all.results.get("7"), "v7");

  // ── 2. Out of time: what was answered is kept, the rest is reported ──
  let started = 0;
  const t0 = Date.now();
  const slow = await boundedLookups(
    ids,
    async (id) => {
      started++;
      await sleep(id === "0" ? 5 : 400);
      return id;
    },
    { concurrency: 2, budgetMs: 60 },
  );
  assert.ok(Date.now() - t0 < 300, "it stops waiting at the deadline");
  assert.equal(slow.results.get("0"), "0", "an answer that came in time is kept");
  assert.ok(slow.unchecked.length >= 10);
  assert.ok(started <= 4, `lookups past the deadline are never started (started ${started})`);
  assert.deepEqual(slow.unchecked, ids.filter((id) => !slow.results.has(id)), "unchecked is the rest, in order");

  // ── 3. A lookup that throws is unchecked, and does not sink the others ──
  const mixed = await boundedLookups(
    ["a", "b", "c"],
    async (id) => {
      if (id === "b") throw new Error("boom");
      return id;
    },
    { concurrency: 2, budgetMs: 1_000 },
  );
  assert.deepEqual([...mixed.results.keys()], ["a", "c"]);
  assert.deepEqual(mixed.unchecked, ["b"]);
  assert.deepEqual(await boundedLookups([], async () => 1, { concurrency: 3, budgetMs: 10 }), { results: new Map(), unchecked: [] });

  // ── 4. Ticket states: the copy first, Freshdesk only for what it lacks ──
  today.clearTicketStateCache();
  const asked: string[] = [];
  const healthy = await today.liveTicketStates(["1", "2", "3", "2"], {
    fromMirror: async (id) => (id === "3" ? null : st("open", id === "1")),
    fromFreshdesk: async (id) => {
      asked.push(id);
      return st("resolved", false);
    },
  });
  assert.deepEqual(asked, ["3"], "Freshdesk is asked only about the ticket the copy lacks");
  assert.equal(healthy.unchecked, 0);
  assert.deepEqual(healthy.states.get("1"), st("open", true));
  assert.deepEqual(healthy.states.get("3"), st("resolved", false));

  // Cached: a second build inside the minute asks nobody.
  asked.length = 0;
  let mirrorCalls = 0;
  await today.liveTicketStates(["1", "2", "3"], {
    fromMirror: async () => (mirrorCalls++, null),
    fromFreshdesk: async (id) => (asked.push(id), st("open", false)),
  });
  assert.equal(mirrorCalls + asked.length, 0);

  // ── 5. The copy down and Freshdesk refusing: the brief still comes back ──
  today.clearTicketStateCache();
  const many = Array.from({ length: 25 }, (_, i) => String(14700 + i));
  let inFlight = 0;
  let fdPeak = 0;
  const t1 = Date.now();
  const down = await today.liveTicketStates(many, {
    fromMirror: async () => {
      throw new Error("a usage quota has been exceeded");
    },
    fromFreshdesk: async () => {
      inFlight++;
      fdPeak = Math.max(fdPeak, inFlight);
      await sleep(30_000); // a 429 waiting out its Retry-After
      inFlight--;
      return st("open", false);
    },
    budgetMs: 80,
  });
  assert.ok(Date.now() - t1 < 400, "the brief does not wait on Freshdesk's retries");
  assert.equal(fdPeak, today.FD_FALLBACK_CONCURRENCY, "a few at a time, not all 25 at once");
  assert.equal(down.unchecked, 25);
  assert.equal(down.states.size, 25, "every ticket still gets a state");
  assert.deepEqual(down.states.get("14700"), st(null, false), "unknown fails open on status, closed on a reply owed");

  // Giving up is not remembered: the next load asks again.
  asked.length = 0;
  const again = await today.liveTicketStates(["14700"], {
    fromMirror: async () => null,
    fromFreshdesk: async (id) => (asked.push(id), st("closed", false)),
  });
  assert.deepEqual(asked, ["14700"]);
  assert.equal(again.states.get("14700")?.status, "closed");

  // ── 6. The limits leave the route room inside its 60 seconds ──
  assert.ok(today.FD_FALLBACK_BUDGET_MS + INSIGHT_TIMEOUT_MS <= 55_000, "brief + model call must finish before the route's 60s limit");
  assert.ok(today.FD_FALLBACK_CONCURRENCY <= 5);

  console.log("today-degrade-test: all assertions passed");
  process.exit(0); // the 30-second stand-ins for Freshdesk are still sleeping
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
