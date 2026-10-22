/**
 * The follow-up sweep end to end against a fake Freshdesk: note → send →
 * next touch → close, and every way a follow-up must NOT go out (customer
 * replied, colleague replied, jetta-hold, dev item, the writer saying no, a
 * second ticket from the same customer, a dry run). No network, no Redis.
 *
 *   npx tsx scripts/ticket-followup-run-test.ts
 */
import assert from "node:assert/strict";
import { runTicketFollowUps, type Listed, type RunDeps, type ThreadRead } from "../lib/ticket-followup-run";
import { getTicketFollowUp, saveTicketFollowUp, type Written, type WriterInput } from "../lib/ticket-followup";

let failures = 0;
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    failures++;
    console.log(`✗ ${name}\n  ${e instanceof Error ? e.message : String(e)}`);
  }
}

type Msg = ThreadRead["messages"][number];
interface FakeTicket {
  listed: Listed;
  requester: string;
  messages: Msg[];
}

/** A fake Freshdesk whose list stats move the way the real ones do — notes included, the worst case. */
function fake(tickets: FakeTicket[], writer?: (i: WriterInput, rejected?: { body: string; reason: string }) => Written) {
  const clock = { now: 0 };
  const sent: { id: string; body: string }[] = [];
  const notes: { id: string; text: string }[] = [];
  const resolved: string[] = [];
  const writes: WriterInput[] = [];
  let reads = 0;
  const devItems = new Map<string, { state?: string; status: string; id: string; title: string }[]>();
  const byId = (id: string) => tickets.find((t) => String(t.listed.id) === id)!;
  const bump = (t: FakeTicket, who: "agent" | "customer") => {
    const at = new Date(clock.now).toISOString();
    t.listed.stats = { ...t.listed.stats, [who === "agent" ? "agent_responded_at" : "requester_responded_at"]: at };
  };
  const defaultWriter = (i: WriterInput): Written => ({
    decision: "send",
    waitingOn: "the board invite",
    reason: "we asked for access",
    body: `Hi Mike,\n\nThis is follow-up number ${i.touch}, asking about the board invite in its own words (variant ${i.touch}).`,
  });
  const deps: RunDeps = {
    listTickets: async () => tickets.map((t) => t.listed),
    readThread: async (id) => {
      reads++;
      const t = byId(id);
      return { requester: t.requester, messages: t.messages };
    },
    addNote: async (id, text) => {
      notes.push({ id, text });
      const t = byId(id);
      t.messages.push({ at: new Date(clock.now).toISOString(), direction: "agent", author: "App Support", body: text, private: true });
      bump(t, "agent");
    },
    reply: async (id, body) => {
      sent.push({ id, body });
      const t = byId(id);
      t.messages.push({ at: new Date(clock.now + 3000).toISOString(), direction: "agent", author: "App Support", body, private: false });
      bump(t, "agent");
    },
    resolve: async (id) => {
      resolved.push(id);
      byId(id).listed.status = 4;
    },
    escalationTs: async () => null,
    devItems: async (id) => devItems.get(id) ?? [],
    ownAccountName: async () => "App Support",
    write: async (i, rejected) => {
      writes.push(i);
      return (writer ?? defaultWriter)(i, rejected);
    },
    log: async () => {},
    outcome: async () => {},
    sleep: async () => {},
  };
  const run = (iso: string, write = true) => {
    clock.now = Date.parse(iso);
    return runTicketFollowUps({ write, preview: false, now: clock.now, readBudget: 6 }, deps);
  };
  return { run, sent, notes, resolved, writes, devItems, clock, reads: () => reads, deps };
}

let nextId = 1000;
/** Customer wrote Thu 15 Oct 15:00 UTC; Cherryl answered at 16:00 and set "waiting on customer". */
function ticket(over: Partial<Listed> = {}, requester = "Mike McArdle <mike@acme.com>"): FakeTicket {
  return {
    requester,
    listed: {
      id: nextId++,
      subject: "Status column stops updating",
      status: 6,
      source: 1,
      tags: [],
      requester_id: nextId,
      created_at: "2026-10-15T15:00:00Z",
      stats: { agent_responded_at: "2026-10-15T16:00:00Z", requester_responded_at: null },
      ...over,
    },
    messages: [
      { at: "2026-10-15T15:00:00Z", direction: "customer", author: "customer", body: "The status column stopped updating.", private: false },
      { at: "2026-10-15T16:00:00Z", direction: "agent", author: "Cherryl", body: "Could you invite support@jetpackwork.com to the board?", private: false },
    ],
  };
}

/** Advance through note → send for whichever touch is due next, returning the send time. */
async function noteThenSend(f: ReturnType<typeof fake>, id: string) {
  const s = (await getTicketFollowUp(id))!;
  const due = new Date(s.dueAt + 60_000).toISOString();
  const r1 = await f.run(due);
  assert.equal(r1.handled.find((h) => h.ticketId === id)?.action, "noted", JSON.stringify(r1.handled));
  const p = (await getTicketFollowUp(id))!.pending!;
  const r2 = await f.run(new Date(p.sendAt + 60_000).toISOString());
  return r2.handled.find((h) => h.ticketId === id)?.action;
}

async function main() {
  await test("three touches, each a day it's due, then the ticket is resolved", async () => {
    const t = ticket();
    const id = String(t.listed.id);
    const f = fake([t]);

    // Friday: touch 1 isn't due until Monday at the customer's hour (15:xx UTC).
    let r = await f.run("2026-10-16T10:00:00Z");
    assert.equal(r.handled[0].action, "waiting");
    const s = (await getTicketFollowUp(id))!;
    assert.equal(new Date(s.dueAt).toISOString().slice(0, 13), "2026-10-19T15");
    assert.equal(f.notes.length + f.sent.length, 0, "nothing posted before it's due");

    // Monday after 15:xx: written and announced, not sent.
    r = await f.run(new Date(s.dueAt + 60_000).toISOString());
    assert.equal(r.handled[0].action, "noted");
    assert.equal(f.notes.length, 1);
    assert.match(f.notes[0].text, /follow-up 1 of 3/);
    assert.match(f.notes[0].text, /jetta-hold/);
    assert.equal(f.sent.length, 0);

    // 20 minutes later: the note's hour isn't up.
    r = await f.run(new Date(s.dueAt + 21 * 60_000).toISOString());
    assert.equal(r.handled[0]?.action ?? "not read", "waiting");
    assert.equal(f.sent.length, 0);

    // After the hour: sent, exactly the text on the note, signed by Jetta.
    const p = (await getTicketFollowUp(id))!.pending!;
    r = await f.run(new Date(p.sendAt + 60_000).toISOString());
    assert.equal(r.handled[0].action, "sent");
    assert.equal(f.sent.length, 1);
    assert.ok(f.notes[0].text.includes(f.sent[0].body), "the note shows the exact text that went out");
    assert.match(f.sent[0].body, /^Hi Mike,/);
    assert.match(f.sent[0].body, /Best,\nJetta\nJetpack Apps Support$/);

    // Her own touch does not restart the count.
    const after1 = (await getTicketFollowUp(id))!;
    assert.equal(after1.touches.length, 1);
    assert.equal(after1.anchorAt, "2026-10-15T16:00:00Z", "kept in Freshdesk's own format, which the restart check compares");
    assert.equal(new Date(after1.dueAt).toISOString().slice(0, 10), "2026-10-22", "touch 2: three business days after touch 1");

    assert.equal(await noteThenSend(f, id), "sent");
    assert.equal(f.writes.at(-1)!.touch, 2);
    assert.equal(f.writes.at(-1)!.previousTouches.length, 1, "touch 2 sees touch 1, so it can't repeat it");

    assert.equal(await noteThenSend(f, id), "sent_and_resolved");
    assert.equal(f.writes.at(-1)!.touch, 3);
    assert.match(f.notes.at(-1)!.text, /last one/);
    assert.equal(f.sent.length, 3);
    assert.deepEqual(f.resolved, [id]);
    assert.equal(await getTicketFollowUp(id), null, "state is cleared after the close");
    assert.equal(new Set(f.sent.map((x) => x.body)).size, 3, "three different messages");

    // Resolved now: never touched again.
    r = await f.run("2026-11-05T15:00:00Z");
    assert.equal(f.sent.length, 3);
  });

  await test("customer replies while a touch waits on its note → it is never sent", async () => {
    const t = ticket();
    const id = String(t.listed.id);
    const f = fake([t]);
    await f.run("2026-10-16T10:00:00Z");
    const s = (await getTicketFollowUp(id))!;
    await f.run(new Date(s.dueAt + 60_000).toISOString());
    assert.equal(f.notes.length, 1);
    // The customer writes back.
    f.clock.now = s.dueAt + 10 * 60_000;
    t.messages.push({ at: new Date(f.clock.now).toISOString(), direction: "customer", author: "customer", body: "Invited you!", private: false });
    t.listed.stats = { ...t.listed.stats, requester_responded_at: new Date(f.clock.now).toISOString() };
    t.listed.status = 12;
    const r = await f.run(new Date(s.dueAt + 3 * 3600_000).toISOString());
    assert.equal(r.handled[0].action, "no_longer_waiting");
    assert.equal(f.sent.length, 0);
    assert.equal(await getTicketFollowUp(id), null);
  });

  await test("a colleague's own follow-up restarts the count instead of piling on", async () => {
    const t = ticket();
    const id = String(t.listed.id);
    const f = fake([t]);
    await f.run("2026-10-16T10:00:00Z");
    assert.equal(await noteThenSend(f, id), "sent");
    // Cherryl follows up by hand on Tuesday.
    f.clock.now = Date.parse("2026-10-20T09:00:00Z");
    t.messages.push({ at: "2026-10-20T09:00:00Z", direction: "agent", author: "Cherryl", body: "Hi Mike, any luck with the invite?", private: false });
    t.listed.stats = { ...t.listed.stats, agent_responded_at: "2026-10-20T09:00:00Z" };
    const r = await f.run("2026-10-20T10:00:00Z");
    assert.equal(r.handled[0].action, "waiting");
    const s = (await getTicketFollowUp(id))!;
    assert.equal(s.anchorBy, "Cherryl");
    assert.equal(s.touches.length, 0);
    assert.equal(new Date(s.dueAt).toISOString().slice(0, 10), "2026-10-22", "two business days after Cherryl's message");
    // Her old schedule (touch 2 on the 22nd from her own touch) is gone; the
    // next thing she writes is a first touch after Cherryl's.
    await f.run(new Date(s.dueAt + 60_000).toISOString());
    assert.equal(f.writes.at(-1)!.touch, 1);
  });

  await test("a colleague replying while her touch waits on the note cancels it, with a note", async () => {
    const t = ticket();
    const id = String(t.listed.id);
    const f = fake([t]);
    await f.run("2026-10-16T10:00:00Z");
    const s = (await getTicketFollowUp(id))!;
    await f.run(new Date(s.dueAt + 60_000).toISOString());
    t.messages.push({ at: new Date(s.dueAt + 5 * 60_000).toISOString(), direction: "agent", author: "Sujata", body: "Mike, I've also sent a Loom.", private: false });
    t.listed.stats = { ...t.listed.stats, agent_responded_at: new Date(s.dueAt + 5 * 60_000).toISOString() };
    await f.run(new Date(s.dueAt + 3 * 3600_000).toISOString());
    assert.equal(f.sent.length, 0);
    assert.match(f.notes.at(-1)!.text, /cancelled: Sujata replied/);
  });

  await test("a colleague's 'I'll close this ticket for now' stops the follow-ups for good (#14557)", async () => {
    const t = ticket();
    const id = String(t.listed.id);
    const f = fake([t]);
    await f.run("2026-10-16T10:00:00Z");
    assert.equal(await noteThenSend(f, id), "sent");
    const after1 = (await getTicketFollowUp(id))!;
    // The next day Cherryl sends her closing template; the status stays "waiting on customer".
    const closedAt = new Date(Date.parse(after1.touches[0].sentAt) + 23 * 3600_000).toISOString().slice(0, 19) + "Z";
    t.messages.push({
      at: closedAt,
      direction: "agent",
      author: "Cherryl",
      body: "Hi Mike, I'm reaching out to let you know that we haven't heard back from you regarding your request, so I will go ahead and close this ticket for now.",
      private: false,
    });
    t.listed.stats = { ...t.listed.stats, agent_responded_at: closedAt };
    const r = await f.run(new Date(Date.parse(closedAt) + 3600_000).toISOString());
    assert.equal(r.handled[0].action, "stopped");
    assert.match(r.handled[0].detail ?? "", /Cherryl closed it/);
    // Days later, when a new round would have been due: nothing, and no re-reads.
    const readsBefore = f.reads();
    await f.run("2026-11-02T18:00:00Z");
    await f.run("2026-11-06T18:00:00Z");
    assert.equal(f.sent.length, 1, "only the one touch before the close");
    assert.equal(f.reads(), readsBefore, "a stopped ticket isn't re-read");
  });

  await test("a closing message while a touch waits on its note cancels it, and says why", async () => {
    const t = ticket();
    const id = String(t.listed.id);
    const f = fake([t]);
    await f.run("2026-10-16T10:00:00Z");
    const s = (await getTicketFollowUp(id))!;
    await f.run(new Date(s.dueAt + 60_000).toISOString());
    const at = new Date(s.dueAt + 5 * 60_000).toISOString();
    t.messages.push({ at, direction: "agent", author: "Cherryl", body: "We haven't heard back, so I'll go ahead and close this ticket for now.", private: false });
    t.listed.stats = { ...t.listed.stats, agent_responded_at: at };
    await f.run(new Date(s.dueAt + 3 * 3600_000).toISOString());
    assert.equal(f.sent.length, 0);
    assert.match(f.notes.at(-1)!.text, /cancelled: Cherryl closed the ticket with the customer/);
    assert.ok((await getTicketFollowUp(id))?.stopped);
  });

  await test("a count that already restarted from a closing message stops when it comes due (#14560)", async () => {
    const t = ticket();
    t.messages[1].body = "We haven't heard back from you, so I will go ahead and close this ticket for now.";
    const id = String(t.listed.id);
    const f = fake([t]);
    // State saved before the close check existed: anchored on the close, touch 1 due.
    await f.run("2026-10-16T10:00:00Z");
    const s = (await getTicketFollowUp(id))!;
    assert.ok(s.stopped, "a fresh read stops at once");
    await saveTicketFollowUp({ ...s, stopped: undefined });
    const r = await f.run(new Date(s.dueAt + 60_000).toISOString());
    assert.equal(r.handled[0].action, "stopped");
    assert.equal(f.sent.length + f.notes.length, 0, "nothing posted");
  });

  await test("jetta-hold cancels a waiting touch", async () => {
    const t = ticket();
    const id = String(t.listed.id);
    const f = fake([t]);
    await f.run("2026-10-16T10:00:00Z");
    const s = (await getTicketFollowUp(id))!;
    await f.run(new Date(s.dueAt + 60_000).toISOString());
    t.listed.tags = ["jetta-hold"];
    await f.run(new Date(s.dueAt + 3 * 3600_000).toISOString());
    assert.equal(f.sent.length, 0);
    assert.match(f.notes.at(-1)!.text, /cancelled: the ticket is tagged jetta-hold/);
    assert.equal(await getTicketFollowUp(id), null);
  });

  await test("dev item in progress → no follow-up and no note; 'Waiting Customer' → check-ins but never the close", async () => {
    const a = ticket();
    const b = ticket({}, "Lise Berg <lise@b.com>");
    const f = fake([a, b]);
    f.devItems.set(String(a.listed.id), [{ id: "1", title: "Fix sync", status: "Working on it", state: "open" }]);
    f.devItems.set(String(b.listed.id), [{ id: "2", title: "Needs repro", status: "Waiting Customer", state: "open" }]);
    await f.run("2026-10-16T10:00:00Z");
    const r = await f.run("2026-10-19T23:00:00Z");
    const ra = r.handled.find((h) => h.ticketId === String(a.listed.id))!;
    assert.equal(ra.action, "stopped");
    assert.match(ra.detail!, /open dev item/);
    assert.ok(!f.notes.some((n) => n.id === String(a.listed.id)), "a stop before any touch needs no note");
    const bid = String(b.listed.id);
    assert.equal(r.handled.find((h) => h.ticketId === bid)!.action, "noted");
    // Through touches 1 and 2…
    const p = (await getTicketFollowUp(bid))!.pending!;
    await f.run(new Date(p.sendAt + 60_000).toISOString());
    assert.equal(await noteThenSend(f, bid), "sent");
    // …but at touch 3 (the close) it stops and tells the team.
    const s = (await getTicketFollowUp(bid))!;
    const r3 = await f.run(new Date(s.dueAt + 60_000).toISOString());
    assert.equal(r3.handled.find((h) => h.ticketId === bid)!.action, "stopped");
    assert.match(f.notes.at(-1)!.text, /stopped following up after 2 of 3/);
    assert.deepEqual(f.resolved, []);
  });

  await test("writer says it's our move → stops quietly; a person is needed → note", async () => {
    const a = ticket();
    const b = ticket({}, "Pat Doe <pat@b.com>");
    const f = fake([a, b], (i) =>
      i.firstName === "Mike"
        ? { decision: "our_court", waitingOn: "", reason: "we said Gabriel will get back to them", body: "" }
        : { decision: "needs_person", waitingOn: "", reason: "cancellation request", body: "" },
    );
    await f.run("2026-10-16T10:00:00Z");
    await f.run("2026-10-19T23:00:00Z");
    assert.ok(!f.notes.some((n) => n.id === String(a.listed.id)));
    assert.match(f.notes.find((n) => n.id === String(b.listed.id))!.text, /needs person: cancellation request/);
    assert.equal(f.sent.length, 0);
    // Stopped stays stopped — no re-read, no second model call.
    const calls = f.writes.length;
    await f.run("2026-10-20T23:00:00Z");
    assert.equal(f.writes.length, calls);
  });

  await test("a templated draft is rejected and rewritten once", async () => {
    const t = ticket();
    const f = fake([t], (i, rejected) => ({
      decision: "send",
      waitingOn: "the invite",
      reason: "",
      body: rejected
        ? "Hi Mike,\n\nWere you able to add support@jetpackwork.com to the board? That's all we need to look into the status column."
        : "Hi Mike,\n\nFollowing up on my previous message! Were you able to invite us to the board yet?",
    }));
    await f.run("2026-10-16T10:00:00Z");
    const r = await f.run("2026-10-19T23:00:00Z");
    assert.equal(r.handled[0].action, "noted");
    assert.equal(f.writes.length, 2);
    assert.ok(!f.notes[0].text.includes("Following up on my previous"));
  });

  await test("two tickets from one customer → one follow-up, on the newest", async () => {
    const older = ticket({ requester_id: 77 });
    const newer = ticket({ requester_id: 77, stats: { agent_responded_at: "2026-10-15T17:00:00Z", requester_responded_at: null } });
    const f = fake([older, newer]);
    const r = await f.run("2026-10-16T10:00:00Z");
    assert.deepEqual(r.handled.map((h) => h.ticketId), [String(newer.listed.id)]);
    assert.equal(r.waiting, 1);
  });

  await test("outbound, internal and [TEST] tickets are never followed up", async () => {
    const f = fake([
      ticket({ source: 10, subject: "Would you leave a review?" }),
      ticket({}, "Niro <niro@jetpackwork.com>"),
      ticket({ subject: "[TEST] status column" }),
    ]);
    await f.run("2026-10-16T10:00:00Z");
    const r = await f.run("2026-10-19T23:00:00Z");
    assert.equal(f.writes.length, 0);
    assert.equal(r.read, 0, "a skipped ticket isn't read again while its stamp is unchanged");
  });

  await test("a ticket that only looks like it's waiting is read once, not every run", async () => {
    const t = ticket();
    // Customer wrote last; the stats say agent because of a private draft note.
    t.messages.push({ at: "2026-10-16T08:00:00Z", direction: "customer", author: "customer", body: "Still broken", private: false });
    t.messages.push({ at: "2026-10-16T08:01:00Z", direction: "agent", author: "App Support", body: "draft", private: true });
    t.listed.stats = { agent_responded_at: "2026-10-16T08:01:00Z", requester_responded_at: "2026-10-16T08:00:00Z" };
    const f = fake([t]);
    let r = await f.run("2026-10-16T10:00:00Z");
    assert.equal(r.handled[0].action, "customer_last");
    r = await f.run("2026-10-16T10:20:00Z");
    assert.equal(r.read, 0);
    assert.equal(f.reads(), 1);
  });

  await test("a dry run writes nothing anywhere", async () => {
    const t = ticket();
    const id = String(t.listed.id);
    const f = fake([t]);
    const r = await f.run("2026-10-19T23:00:00Z", false);
    assert.equal(r.handled[0].action, "would_write");
    assert.equal(f.notes.length + f.sent.length + f.resolved.length, 0);
    assert.equal(await getTicketFollowUp(id), null);
  });

  console.log(failures ? `\n${failures} failed` : "\nticket-followup-run-test: all passed");
  if (failures) process.exit(1);
}
main();
