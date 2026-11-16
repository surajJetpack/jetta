/**
 * What the first-response cron does when things go wrong at send time —
 * without a network or a model (fetch is replaced).
 *
 *   npx tsx scripts/first-response-cron-test.ts
 *
 * The webhook has already put a note on the ticket saying "Jetta — sending the
 * first response at HH:MM", and left no draft. So every way this cron can stop
 * short has to end in one of three places: the reply goes out, a person is
 * told it did not, or the job is still there to try again. It used to have a
 * fourth: Freshdesk hiccups, the job is cancelled as "ticket not found", and
 * the ticket goes on promising a reply that no longer exists.
 */
export {};

import type { ScheduledFirstResponse } from "../lib/first-response";

// Before ANY import: lib/config.ts snapshots process.env on first load.
process.env.STUB_MODE = "true";
process.env.FRESHDESK_LIVE = "true";
process.env.FRESHDESK_DOMAIN = "example.freshdesk.test";
process.env.FRESHDESK_API_KEY = "test-key";
process.env.JETTA_FIRST_RESPONSE = "on";
process.env.CRON_SECRET = "cron-test-secret";
for (const v of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_URL", "DATABASE_URL"]) {
  delete process.env[v];
}

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${!ok && detail ? `\n        ${detail}` : ""}`);
}
const section = (name: string) => console.log(`\n── ${name} ──`);

// ── Freshdesk, replaced ──
type Conv = { incoming: boolean; private: boolean; body_text: string; created_at: string };
const fdState = { ticketStatus: 200, conversations: [] as Conv[], replyStatus: 201 };
const sent: string[] = [];
const notes: string[] = [];
globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (method === "POST" && /\/tickets\/\d+\/reply$/.test(url)) {
    if (fdState.replyStatus >= 400) return json(fdState.replyStatus, { message: "nope" });
    sent.push(String(init?.body ?? ""));
    return json(201, { id: 1 });
  }
  if (method === "POST" && /\/tickets\/\d+\/notes$/.test(url)) {
    notes.push(String(init?.body ?? ""));
    return json(201, { id: 2 });
  }
  if (/\/tickets\/\d+\/conversations/.test(url)) {
    return fdState.ticketStatus === 200 ? json(200, fdState.conversations) : json(fdState.ticketStatus, {});
  }
  if (/\/tickets\/\d+(\?|$)/.test(url)) {
    return fdState.ticketStatus === 200
      ? json(200, { id: 14600, subject: "Sync stops", description_text: "It stops.", status: 2, source: 1, tags: [], requester_id: 9, created_at: "2026-11-16T09:00:00Z", updated_at: "2026-11-16T09:00:00Z" })
      : json(fdState.ticketStatus, { message: "error" });
  }
  return json(200, {});
}) as typeof fetch;

async function main() {
  const { NextRequest } = await import("next/server");
  const fr = await import("../lib/first-response");
  const { GET } = await import("../app/api/cron/first-response/route");
  const { markEventSeen, keepEventSeen, unmarkEventSeen } = await import("../lib/kv");
  const { isNotFound } = await import("../lib/tools/freshdesk");

  const tick = async () => {
    const res = await GET(
      new NextRequest("https://jetta.test/api/cron/first-response", { headers: { authorization: "Bearer cron-test-secret" } }),
    );
    return (await res.json()) as { handled: { ticketId: string; action: string; reason?: string }[]; pending: number };
  };
  // Each job gets its own createdAt: the send claim is keyed on it, and with
  // everything in memory several jobs are otherwise made in the same millisecond.
  let seq = 0;
  const job = (over: Partial<ScheduledFirstResponse> = {}): ScheduledFirstResponse => ({
    ticketId: "14600",
    body: "Hi Pat,\n\nTry re-authorising the app.",
    sendAt: Date.now() - 60_000,
    createdAt: Date.now() - 5 * 60_000 + ++seq,
    answersMessageAt: "",
    product: "jetpackapps",
    model: "test",
    toolsUsed: [],
    resolutionSent: false,
    escalated: false,
    gateReason: "ok",
    ...over,
  });
  const reset = async () => {
    for (const j of await fr.listScheduledFirstResponses()) await fr.clearScheduledFirstResponse(j);
    fdState.ticketStatus = 200;
    fdState.conversations = [];
    fdState.replyStatus = 201;
    sent.length = 0;
    notes.length = 0;
  };
  const pending = async () => (await fr.listScheduledFirstResponses()).length;

  section("Freshdesk does not answer at send time");
  await reset();
  await fr.scheduleFirstResponse(job());
  fdState.ticketStatus = 503;
  let out = await tick();
  check("a 503 on the ticket read is an error, not a cancel", out.handled[0]?.action === "error", JSON.stringify(out.handled));
  check("…the reply is still queued", (await pending()) === 1);
  check("…and nothing was sent or noted", sent.length === 0 && notes.length === 0);
  fdState.ticketStatus = 200;
  out = await tick();
  check("the next tick, with Freshdesk back, sends it", out.handled[0]?.action === "sent" && sent.length === 1, JSON.stringify(out.handled));
  check("…and the queue is empty", (await pending()) === 0);

  await reset();
  await fr.scheduleFirstResponse(job({ sendAt: Date.now() - 61 * 60_000 }));
  fdState.ticketStatus = 503;
  out = await tick();
  check("still unreadable an hour past due → gives up", out.handled[0]?.action === "gave_up", JSON.stringify(out.handled));
  check("…and tells a person it was NOT sent", notes.length === 1 && /did NOT send/.test(notes[0]), notes[0]?.slice(0, 160));
  check("…and the job is gone", (await pending()) === 0);

  await reset();
  await fr.scheduleFirstResponse(job());
  fdState.ticketStatus = 404;
  out = await tick();
  check("a real 404 is still a quiet \"not_found\" cancel", out.handled[0]?.action === "cancelled" && out.handled[0]?.reason === "not_found", JSON.stringify(out.handled));
  check("isNotFound reads Freshdesk's 404 and nothing else", isNotFound(new Error("Freshdesk GET /tickets/1 failed: 404 {}")) && !isNotFound(new Error("Freshdesk GET /tickets/1 failed: 503 {}")) && !isNotFound(new TypeError("fetch failed")));

  section("The customer wrote again before it went out");
  await reset();
  await fr.scheduleFirstResponse(job({ answersMessageAt: "2026-11-16T09:00:00Z" }));
  fdState.conversations = [{ incoming: true, private: false, body_text: "Also, it happens on two boards.", created_at: "2026-11-16T09:03:00Z" }];
  out = await tick();
  check("the stale reply is cancelled", out.handled[0]?.reason === "customer_wrote_again" && sent.length === 0, JSON.stringify(out.handled));
  check("…and the ticket is told nothing was sent", notes.length === 1 && /did NOT send[^]*wrote again/.test(notes[0]), notes[0]?.slice(0, 160));

  await reset();
  await fr.scheduleFirstResponse(job({ answersMessageAt: "2026-11-16T09:00:00Z" }));
  fdState.conversations = [
    { incoming: true, private: false, body_text: "I am out of the office until Monday with limited access to email. This is an automatic reply.", created_at: "2026-11-16T09:01:00Z" },
  ];
  out = await tick();
  check("an out-of-office auto-reply does not cancel it: the reply goes out", out.handled[0]?.action === "sent" && sent.length === 1, JSON.stringify(out.handled));

  await reset();
  await fr.scheduleFirstResponse(job());
  fdState.conversations = [{ incoming: false, private: false, body_text: "Hi Pat, a colleague here.", created_at: "2026-11-16T09:02:00Z" }];
  out = await tick();
  check("a teammate replying first still cancels quietly", out.handled[0]?.reason === "answered" && notes.length === 0 && sent.length === 0, JSON.stringify(out.handled));

  section("Two replies queued for one ticket: the newer message wins");
  await reset();
  const newer = job({ answersMessageAt: "2026-11-16T09:05:00Z", body: "reply to message 2", createdAt: 2 });
  const older = job({ answersMessageAt: "2026-11-16T09:00:00Z", body: "reply to message 1", createdAt: 1 });
  check("the newer reply is queued", (await fr.scheduleFirstResponse(newer)) === true);
  check("an older run finishing later does not replace it", (await fr.scheduleFirstResponse(older)) === false);
  check("…the queued reply is still the newer one", (await fr.listScheduledFirstResponses())[0]?.body === "reply to message 2");
  await reset();
  await fr.scheduleFirstResponse(older);
  check("in the ordinary order, the newer reply replaces the older", (await fr.scheduleFirstResponse(newer)) === true && (await fr.listScheduledFirstResponses())[0]?.body === "reply to message 2");

  section("A send that fails is retried, and never doubled");
  await reset();
  await fr.scheduleFirstResponse(job());
  fdState.replyStatus = 500;
  out = await tick();
  check("a failed send is an error and stays queued", out.handled[0]?.action === "error" && (await pending()) === 1, JSON.stringify(out.handled));
  fdState.replyStatus = 201;
  out = await tick();
  check("the retry sends exactly once", out.handled[0]?.action === "sent" && sent.length === 1, JSON.stringify(out.handled));

  section("A claim taken short lapses; a claim kept stays");
  check("claim", await markEventSeen("t:claim", 1));
  check("a second claim is refused while it is held", !(await markEventSeen("t:claim", 1)));
  await new Promise((r) => setTimeout(r, 2100));
  check("left alone (a run killed at its limit), it frees itself", await markEventSeen("t:claim", 1));
  await keepEventSeen("t:claim", 3600);
  await new Promise((r) => setTimeout(r, 2100));
  check("kept (the run finished), it is still held", !(await markEventSeen("t:claim", 1)));
  await unmarkEventSeen("t:claim");
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
