/**
 * One run of the ticket follow-up sweep (lib/ticket-followup.ts has the rules
 * and the why; app/api/cron/ticket-followup is the trigger).
 *
 *   1. one list call — tickets changed in the last 16 days, with Freshdesk's
 *      own "who responded last" stats — picks the tickets where we wrote last
 *      and the status still means the customer has the next move;
 *   2. a ticket's thread is read only when something changed or a touch is
 *      due, and only a few per run, paced: this account's Freshdesk budget is
 *      40 calls a minute, shared with live replies;
 *   3. a due touch is written and posted as a private note; a later run sends
 *      it once its hour on the note is up, after reading the ticket again.
 *
 * Everything that reaches outside goes through `deps`, so the whole state
 * machine — note, send, next touch, close, and every reset — runs against a
 * fake Freshdesk in scripts/ticket-followup-run-test.ts.
 */
import { config } from "./config";
import * as freshdesk from "./tools/freshdesk";
import { devItemsForTicket } from "./tools/monday";
import { followUpCloseBlocker, describeFollowUpBlock } from "./followup-guard";
import { getEscalationTs, recordOutcome } from "./kv";
import { logOpsEvent } from "./events";
import { modelLabel } from "./llm";
import {
  MAX_TOUCHES,
  NOTE_LEAD_MINUTES,
  activeHourOf,
  brandFor,
  clearTicketFollowUp,
  finishTouch,
  firstNameOf,
  getSeenStamps,
  isClosingMessage,
  jitterFor,
  listTicketFollowUps,
  markSeen,
  readThread,
  saveTicketFollowUp,
  skipTicket,
  touchBlock,
  touchDueAt,
  transcriptOf,
  writeTouch,
  type PublicMessage,
  type TicketFollowUp,
} from "./ticket-followup";

/** Full thread reads per run. Each is ~3 Freshdesk calls. */
export const READ_BUDGET = 6;
/** Pause between thread reads, so a run never bursts the shared Freshdesk budget. */
const READ_GAP_MS = 4000;
/** Comfortably past the third touch: 2 + 3 + 3 business days plus weekends. */
const LOOKBACK_DAYS = 16;
const LIST_PAGES = 3;
/** Freshdesk statuses where the customer has the next move — the close guard's set (lib/followup-guard.ts). */
const WAITING_STATUSES: Record<number, string> = { 2: "open", 3: "pending", 6: "waiting on customer" };

/** A ticket as the list endpoint returns it with `include=stats`. */
export interface Listed {
  id: number;
  subject: string;
  status: number;
  source?: number;
  tags?: string[];
  requester_id?: number;
  created_at: string;
  custom_fields?: Record<string, unknown>;
  stats?: { agent_responded_at?: string | null; requester_responded_at?: string | null };
}

/** What a run needs from a thread read. */
export interface ThreadRead {
  /** "Name <email>". */
  requester: string;
  product?: string;
  messages: (PublicMessage & { private: boolean })[];
}

export interface RunDeps {
  listTickets(sinceIso: string): Promise<Listed[]>;
  readThread(ticketId: string): Promise<ThreadRead>;
  addNote(ticketId: string, text: string): Promise<void>;
  reply(ticketId: string, markdown: string): Promise<void>;
  resolve(ticketId: string): Promise<void>;
  escalationTs(ticketId: string): Promise<unknown>;
  /** Null = monday unreadable. */
  devItems(ticketId: string): Promise<{ state?: string; status: string; id: string; title: string }[] | null>;
  ownAccountName(): Promise<string | null>;
  write: typeof writeTouch;
  log: typeof logOpsEvent;
  outcome: typeof recordOutcome;
  sleep(ms: number): Promise<void>;
}

export const liveDeps: RunDeps = {
  async listTickets(since) {
    const out: Listed[] = [];
    for (let page = 1; page <= LIST_PAGES; page++) {
      const batch = await freshdesk.fd<Listed[]>(
        `/tickets?updated_since=${encodeURIComponent(since)}&order_by=updated_at&order_type=desc&per_page=100&page=${page}&include=stats`,
      );
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  },
  readThread: (id) => freshdesk.getTicketThread(id, { limit: 20 }),
  addNote: (id, text) => freshdesk.addPrivateNote(id, text),
  reply: (id, md) => freshdesk.replyToTicket(id, freshdesk.markdownToFdHtml(md)),
  resolve: (id) => freshdesk.closeTicket(id, true),
  escalationTs: getEscalationTs,
  devItems: (id) => devItemsForTicket(id).catch(() => null),
  ownAccountName: async () => (config.freshdesk.agentId ? freshdesk.getAgentName(Number(config.freshdesk.agentId)) : null),
  write: writeTouch,
  log: logOpsEvent,
  outcome: recordOutcome,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** We wrote last and the status says it's on them. From the listing alone, no thread read. */
function isCandidate(t: Listed): boolean {
  if (!(t.status in WAITING_STATUSES)) return false;
  const agent = t.stats?.agent_responded_at;
  if (!agent) return false;
  return agent > (t.stats?.requester_responded_at ?? t.created_at);
}

const stampOf = (t: Listed) =>
  [t.status, t.stats?.agent_responded_at ?? "", t.stats?.requester_responded_at ?? "", (t.tags ?? []).join(",")].join("|");

function needsRead(s: TicketFollowUp | undefined, t: Listed, now: number): boolean {
  if (!s || s.stamp !== stampOf(t)) return true;
  if (s.stopped) return false;
  return s.pending ? now >= s.pending.sendAt : now >= s.dueAt;
}

/** Due work first, so a backlog of new tickets can never starve a touch that's ready to go. */
function priority(s: TicketFollowUp | undefined, now: number): number {
  if (s?.pending && now >= s.pending.sendAt) return 0;
  if (s && !s.stopped && now >= s.dueAt) return 1;
  return 2;
}

export type Handled = { ticketId: string; action: string; detail?: string; text?: string };

export interface RunOptions {
  /** Send, note and save. False = report only. */
  write: boolean;
  /** Without write: still have her write the due touches, to read them. */
  preview: boolean;
  now: number;
  readBudget: number;
}

export async function runTicketFollowUps(opts: RunOptions, deps: RunDeps = liveDeps) {
  const { now } = opts;
  const since = new Date(now - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 19) + "Z";
  const listed = await deps.listTickets(since);
  const states = new Map((await listTicketFollowUps()).map((s) => [s.ticketId, s]));
  const handled: Handled[] = [];

  // One conversation per customer: someone with two tickets on the same
  // problem (it happens — #14567/#14568) gets followed up on the one we
  // answered most recently, never twice in a day.
  const newestPerRequester = new Map<number, Listed>();
  for (const t of listed.filter(isCandidate)) {
    const key = t.requester_id ?? -t.id;
    const cur = newestPerRequester.get(key);
    if (!cur || (t.stats?.agent_responded_at ?? "") > (cur.stats?.agent_responded_at ?? "")) newestPerRequester.set(key, t);
  }
  const candidates = [...newestPerRequester.values()];
  const candidateIds = new Set(candidates.map((t) => String(t.id)));

  // A ticket she was following that is no longer waiting on the customer
  // (they replied, someone changed the status) is done with.
  for (const t of listed) {
    const id = String(t.id);
    if (states.has(id) && !candidateIds.has(id)) {
      if (opts.write) await clearTicketFollowUp(id);
      handled.push({ ticketId: id, action: "no_longer_waiting" });
    }
  }

  const seen = await getSeenStamps(candidates.filter((t) => !states.has(String(t.id))).map((t) => String(t.id)));
  const work = candidates
    .filter((t) => seen.get(String(t.id)) !== stampOf(t) && needsRead(states.get(String(t.id)), t, now))
    .sort((a, b) => priority(states.get(String(a.id)), now) - priority(states.get(String(b.id)), now));

  let reads = 0;
  for (const t of work) {
    if (reads >= opts.readBudget) break;
    if (reads > 0) await deps.sleep(READ_GAP_MS);
    reads++;
    const id = String(t.id);
    try {
      handled.push(await handle(t, states.get(id), opts, deps));
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      handled.push({ ticketId: id, action: "error", detail: error });
      await deps.log({ level: "error", event: "ticket_followup.failed", source: "cron", ticketId: id, data: { error } });
    }
  }

  if (opts.write && handled.some((h) => h.action !== "waiting")) {
    await deps.log({
      level: handled.some((h) => h.action === "error") ? "warn" : "info",
      event: "ticket_followup.run",
      source: "cron",
      data: { waiting: candidates.length, read: reads, handled },
    });
  }
  return {
    listed: listed.length,
    waiting: candidates.length,
    toRead: work.length,
    read: reads,
    handled,
    following: [...states.values()]
      .filter((s) => candidateIds.has(s.ticketId))
      .map((s) => ({
        ticketId: s.ticketId,
        touchesSent: s.touches.length,
        next: s.stopped ? `stopped: ${s.stopped.reason}` : new Date(s.pending?.sendAt ?? s.dueAt).toISOString(),
        pending: !!s.pending,
      })),
  };
}

async function handle(t: Listed, prev: TicketFollowUp | undefined, opts: RunOptions, deps: RunDeps): Promise<Handled> {
  const { write, preview, now } = opts;
  const ticketId = String(t.id);
  const thread = await deps.readThread(ticketId);
  const requesterEmail = /<([^>]+)>/.exec(thread.requester)?.[1] ?? null;
  const note = (text: string) => (write ? deps.addNote(ticketId, text) : Promise.resolve());

  const skip = skipTicket({ source: t.source, subject: t.subject, tags: t.tags, requesterEmail });
  if (skip) {
    if (write) await markSeen(ticketId, stampOf(t));
    if (write && prev) {
      if (prev.pending && skip === "hold_tag") await note(`Follow-up ${prev.pending.n} of ${MAX_TOUCHES} cancelled: the ticket is tagged jetta-hold.`);
      await clearTicketFollowUp(ticketId);
    }
    return { ticketId, action: "skipped", detail: skip };
  }

  const messages: PublicMessage[] = thread.messages
    .filter((m) => !m.private)
    .map((m) => ({ at: m.at, direction: m.direction, author: m.author, body: m.body }));
  const read = readThread(messages, prev?.touches.map((x) => x.sentAt) ?? []);
  if (read.kind === "customer_last") {
    if (write) await markSeen(ticketId, stampOf(t));
    if (write && prev) await clearTicketFollowUp(ticketId);
    return { ticketId, action: "customer_last" };
  }

  // A reply from anyone but her since the count started restarts it from that reply.
  let s: TicketFollowUp;
  if (prev && prev.anchorAt === read.anchor.at) {
    s = { ...prev, stamp: stampOf(t) };
  } else {
    const closed = isClosingMessage(read.anchor.body);
    if (prev?.pending) {
      await note(
        closed
          ? `Follow-up ${prev.pending.n} of ${MAX_TOUCHES} cancelled: ${read.anchor.author} closed the ticket with the customer, so Jetta stops here.`
          : `Follow-up ${prev.pending.n} of ${MAX_TOUCHES} cancelled: ${read.anchor.author} replied, so the count starts again from that reply.`,
      );
    }
    const activeHourUtc = activeHourOf(read.lastCustomerAt);
    s = {
      ticketId,
      subject: t.subject,
      anchorAt: read.anchor.at,
      anchorBy: read.anchor.author,
      touches: [],
      dueAt: touchDueAt(Date.parse(read.anchor.at), 1, activeHourUtc, jitterFor(ticketId, 1)),
      activeHourUtc,
      stamp: stampOf(t),
      updatedAt: now,
    };
    // A colleague told the customer the ticket is closed: respect that
    // rather than opening a new round of follow-ups after it.
    if (closed) {
      s = { ...s, stopped: { reason: `${read.anchor.author} closed it with the customer`, at: new Date(now).toISOString() } };
      if (write) await saveTicketFollowUp(s);
      await stopped(opts, deps, ticketId, 1, s.stopped!.reason);
      return { ticketId, action: "stopped", detail: s.stopped!.reason };
    }
  }
  const save = async () => {
    if (write) await saveTicketFollowUp(s);
  };

  if (s.stopped) {
    await save();
    return { ticketId, action: "stopped", detail: s.stopped.reason };
  }
  const n = s.pending?.n ?? s.touches.length + 1;
  if (n > MAX_TOUCHES) {
    if (write) await clearTicketFollowUp(ticketId);
    return { ticketId, action: "done" };
  }
  const dueAt = s.pending?.sendAt ?? s.dueAt;
  if (now < dueAt) {
    await save();
    return { ticketId, action: "waiting", detail: `touch ${n} ${s.pending ? "sends" : "due"} ${new Date(dueAt).toISOString()}` };
  }

  // Engineering still has it, or the ticket is escalated: the next move is
  // ours, whatever the thread's last message looks like.
  const [escalationTs, devItems] = await Promise.all([deps.escalationTs(ticketId), deps.devItems(ticketId)]);
  // One exception: engineering parked the item on the customer ("Waiting
  // Customer"), which is exactly when a check-in helps. Never the close,
  // though — a ticket with an open dev item is not resolved for silence.
  const openItems = devItems ? devItems.filter((i) => i.state === "open") : null;
  const devWaitsOnCustomer = !!openItems?.length && openItems.every((i) => /waiting.*customer/i.test(i.status));
  const block = followUpCloseBlocker(
    WAITING_STATUSES[t.status] ?? null,
    !!escalationTs,
    devWaitsOnCustomer && n < MAX_TOUCHES ? [] : openItems,
  );
  if (block) {
    if (block.retry) return { ticketId, action: "held", detail: describeFollowUpBlock(block) };
    const reason = describeFollowUpBlock(block);
    if (s.pending || s.touches.length) {
      await note(`Jetta stopped following up after ${s.touches.length} of ${MAX_TOUCHES} follow-ups: ${reason}. Over to the team.`);
    }
    s = { ...s, pending: undefined, stopped: { reason, at: new Date(now).toISOString() } };
    await save();
    await stopped(opts, deps, ticketId, n, reason);
    return { ticketId, action: "stopped", detail: reason };
  }

  const { product, brand } = brandFor(thread.product, `${t.subject}\n${messages.map((m) => m.body).join("\n")}`);

  // ── send a touch that has sat on the ticket for its hour ──
  if (s.pending) {
    const { body } = s.pending;
    if (!write) return { ticketId, action: "would_send", detail: `touch ${n}`, text: body };
    await deps.reply(ticketId, body);
    const sentAt = new Date(now).toISOString();
    s = { ...s, pending: undefined, touches: [...s.touches, { n, sentAt, body }] };
    if (n === MAX_TOUCHES) {
      await deps.resolve(ticketId);
      await clearTicketFollowUp(ticketId);
      await deps
        .outcome({
          ticketId,
          subject: t.subject,
          at: Math.floor(now / 1000),
          channel: "freshdesk",
          product,
          model: modelLabel(),
          toolsUsed: ["reply_to_ticket", "close_ticket"],
          replied: true,
          resolutionSent: false,
          escalated: false,
          kind: "closed",
        })
        .catch(() => {});
      await deps.log({ level: "info", event: "ticket_followup.resolved", source: "cron", ticketId, data: { touch: n } });
      return { ticketId, action: "sent_and_resolved", detail: `touch ${n}` };
    }
    s.dueAt = touchDueAt(now, n + 1, s.activeHourUtc, jitterFor(ticketId, n + 1));
    await save();
    await deps.log({ level: "info", event: "ticket_followup.sent", source: "cron", ticketId, data: { touch: n, next: new Date(s.dueAt).toISOString() } });
    return { ticketId, action: "sent", detail: `touch ${n}, next ${new Date(s.dueAt).toISOString()}` };
  }

  // ── write the touch that's due ──
  if (!write && !preview) return { ticketId, action: "would_write", detail: `touch ${n}` };

  const firstName = firstNameOf(thread.requester);
  const transcript = transcriptOf(messages);
  const previousTouches = s.touches.map((x) => x.body);
  const input = { touch: n, brand, firstName, subject: t.subject, transcript, previousTouches, ownAccountName: await deps.ownAccountName() };

  let written = await deps.write(input);
  let blocked = written.decision === "send" ? touchBlock(written.body, transcript, previousTouches) : null;
  if (blocked) {
    written = await deps.write(input, { body: written.body, reason: blocked });
    blocked = written.decision === "send" ? touchBlock(written.body, transcript, previousTouches) : null;
  }

  if (written.decision !== "send" || blocked) {
    const reason = blocked ? `couldn't write a clean follow-up (${blocked})` : `${written.decision.replace("_", " ")}: ${written.reason}`;
    if (!write) return { ticketId, action: "would_stop", detail: reason, text: written.body || undefined };
    s = { ...s, stopped: { reason, at: new Date(now).toISOString() } };
    await save();
    // "Our court" and "already resolved" are the commonest stops and need
    // nobody: a note on every one is noise. Only the ones a person should
    // pick up get a note.
    if (blocked || written.decision === "needs_person") {
      await note(`Jetta didn't send follow-up ${n} of ${MAX_TOUCHES} (${reason}). Over to the team if the customer still needs anything.`);
    }
    await stopped(opts, deps, ticketId, n, reason);
    return { ticketId, action: "stopped", detail: reason };
  }

  const body = finishTouch(written.body, firstName, brand);
  const [lo, hi] = NOTE_LEAD_MINUTES;
  const sendAt = now + Math.round((lo + (hi - lo) * Math.random()) * 60_000);
  if (!write) return { ticketId, action: "would_note", detail: `touch ${n}, waiting on: ${written.waitingOn}`, text: body };

  const when = new Date(sendAt).toISOString().slice(11, 16);
  await note(
    [
      `Jetta will send follow-up ${n} of ${MAX_TOUCHES} at about ${when} UTC unless someone replies first or tags the ticket jetta-hold.`,
      `Waiting on: ${written.waitingOn}`,
      "",
      body,
      n === MAX_TOUCHES ? "\nThis is the last one: the ticket will be resolved after it, and a reply from the customer reopens it." : "",
    ].join("\n"),
  );
  s = { ...s, pending: { n, body, sendAt, notedAt: new Date(now).toISOString() } };
  await save();
  await deps.log({ level: "info", event: "ticket_followup.noted", source: "cron", ticketId, data: { touch: n, sendAt: new Date(sendAt).toISOString(), waitingOn: written.waitingOn } });
  return { ticketId, action: "noted", detail: `touch ${n}, sends ~${when} UTC` };
}

async function stopped(opts: RunOptions, deps: RunDeps, ticketId: string, touch: number, reason: string) {
  if (!opts.write) return;
  await deps.log({ level: "info", event: "ticket_followup.stopped", source: "cron", ticketId, data: { touch, reason } });
}
