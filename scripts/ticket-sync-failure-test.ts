/**
 * A ticket sync that keeps failing must be visible, with the reason.
 *
 * In November 2026 the ticket database refused every query for days (its
 * plan's usage quota had run out). The event log recorded only the query that
 * failed, the cron heartbeat only "HTTP 500", and /system stayed green.
 *
 *   npx tsx scripts/ticket-sync-failure-test.ts
 */
import assert from "node:assert/strict";
import { NextRequest, NextResponse } from "next/server";

delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;

async function main() {
  const { errorWithCauses } = await import("../lib/error-text");
  const { ticketMirrorRow, capabilityRows, TICKET_SYNC_FAILING_AFTER } = await import("../lib/system-status");
  const { withCronBeat, getCronBeats } = await import("../lib/cron-beat");

  // 1. The database's own words survive the client's wrapper.
  const quota = new Error("A usage quota has been exceeded.");
  const wrapped = new Error('Failed query: select "key" from "sync_state"', { cause: quota });
  assert.equal(errorWithCauses(wrapped), 'Failed query: select "key" from "sync_state" | caused by: A usage quota has been exceeded.');
  assert.equal(errorWithCauses(new Error("plain")), "plain");
  assert.equal(errorWithCauses("a string"), "a string");
  assert.equal(errorWithCauses(new Error("same", { cause: new Error("same") })), "same", "a repeated message is said once");
  const loop = new Error("loop") as Error & { cause?: unknown };
  loop.cause = loop;
  assert.equal(errorWithCauses(loop), "loop", "a cause that points at itself ends");

  // 2. The heartbeat keeps what a failed run said, not just its status.
  const failing = withCronBeat("test-sync", async () => NextResponse.json({ error: errorWithCauses(wrapped) }, { status: 500 }));
  for (let i = 0; i < TICKET_SYNC_FAILING_AFTER; i++) await failing(new NextRequest("http://localhost/api/cron/test-sync"));
  const beat = (await getCronBeats())["test-sync"];
  assert.equal(beat.failStreak, TICKET_SYNC_FAILING_AFTER);
  assert.match(beat.lastError ?? "", /^HTTP 500: Failed query/);
  assert.match(beat.lastError ?? "", /usage quota/);

  const bare = withCronBeat("test-bare", async () => new NextResponse("nope", { status: 500 }));
  await bare(new NextRequest("http://localhost/api/cron/test-bare"));
  assert.equal((await getCronBeats())["test-bare"].lastError, "HTTP 500", "a failure with no JSON error keeps the status");

  const fine = withCronBeat("test-ok", async () => NextResponse.json({ error: "ignored on success" }));
  await fine(new NextRequest("http://localhost/api/cron/test-ok"));
  assert.equal((await getCronBeats())["test-ok"].lastError, undefined);

  // 3. /system says so, and goes back to normal once a run works.
  delete process.env.DATABASE_URL;
  assert.equal(ticketMirrorRow(beat).state, "NO DATABASE", "no database: nothing to fail");

  process.env.DATABASE_URL = "postgres://example.invalid/db";
  const row = ticketMirrorRow(beat);
  assert.equal(row.state, "SYNC FAILING");
  assert.equal(row.tone, "warn");
  assert.match(row.meaning, /usage quota has been exceeded/);
  assert.match(row.meaning, /No run on record has worked/);
  assert.equal(row.setting, "JETTA_TICKET_MIRROR");

  const withOk = ticketMirrorRow({ ...beat, okAt: Date.UTC(2026, 10, 21, 9, 5) });
  assert.match(withOk.meaning, /It last worked on 2026-11-21 09:05 UTC/);

  const blip = ticketMirrorRow({ ...beat, failStreak: TICKET_SYNC_FAILING_AFTER - 1 });
  assert.notEqual(blip.state, "SYNC FAILING", "one or two failed runs is a blip");
  assert.notEqual(ticketMirrorRow({ at: 1, ms: 1, status: 200, failStreak: 0 }).state, "SYNC FAILING");
  assert.notEqual(ticketMirrorRow().state, "SYNC FAILING", "no heartbeat: the row is as before");

  const inList = capabilityRows({ ticketSyncBeat: beat }).find((r) => r.label === "Ticket mirror reads");
  assert.equal(inList?.state, "SYNC FAILING");
  assert.ok(capabilityRows().some((r) => r.label === "Ticket mirror reads"));

  console.log("ticket-sync-failure-test: all assertions passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
