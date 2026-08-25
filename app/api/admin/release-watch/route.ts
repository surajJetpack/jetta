/**
 * Release-watch admin: inspect the mention store, and backfill it.
 *
 * Live tagging rides the per-ticket triage call, which only covers traffic
 * from the moment a watch turns active — everything customers said BEFORE
 * that sits untagged in Freshdesk and the chat store. POST sweeps that
 * history: every ticket created since the earliest active watch's start date
 * (and every stored chat), through the same classifier triage uses.
 *
 * Read-only against the sources; the only writes are mention records. Safe to
 * re-run — mentions are keyed per (watch, conversation), so a second sweep
 * updates entries rather than duplicating them.
 */
import { NextRequest, NextResponse } from "next/server";
import { adminAuthorized } from "@/lib/auth";
import { searchTickets, getTicketDetails } from "@/lib/tools/freshdesk";
import { listConversations, transcriptText } from "@/lib/chat-store";
import { triageTicket } from "@/lib/context";
import {
  activeReleaseWatches,
  clearReleaseMentions,
  listReleaseMentions,
  recordReleaseMention,
  verifyReleaseEvidence,
} from "@/lib/release-watch";
import { logOpsEvent } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** A sweep is a few hundred light-model calls — give it the full budget. */
export const maxDuration = 300;

const CONCURRENCY = 4;

/** Run `fn` over `items` a few at a time. Individual failures are skipped. */
async function sweep<T>(items: T[], fn: (item: T) => Promise<void>): Promise<number> {
  let failed = 0;
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    await Promise.all(
      items.slice(i, i + CONCURRENCY).map((item) =>
        fn(item).catch(() => {
          failed += 1;
        }),
      ),
    );
  }
  return failed;
}

export async function GET(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({
    watches: activeReleaseWatches(),
    mentions: await listReleaseMentions(),
  });
}

export async function POST(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const watches = activeReleaseWatches();
  if (!watches.length) return NextResponse.json({ error: "no active release watches" }, { status: 400 });

  // reset: wipe before sweeping. The sweep alone cannot remove entries a
  // previously looser classifier recorded — a rebuild is the only way to
  // apply stricter matching retroactively.
  const body = (await req.json().catch(() => ({}))) as { reset?: boolean };
  if (body.reset) await clearReleaseMentions();

  const from = [...watches.map((w) => w.since)].sort()[0];
  const to = new Date().toISOString().slice(0, 10);

  // ── Tickets ──
  const found = await searchTickets({ from, to });
  const tickets = found.tickets.filter((t) => !t.subject.includes("[TEST]"));
  let ticketHits = 0;
  const ticketFailures = await sweep(tickets, async (t) => {
    const details = await getTicketDetails(t.id);
    // The SAME call live tagging runs — one classifier, one behavior. Its
    // intake field keeps marketing blasts and auto-replies out, and the
    // evidence check discards any tag whose feature phrase isn't literally
    // in the message.
    const triage = await triageTicket(details.subject, details.description);
    const release = triage.release;
    if (!release || triage.intake !== "customer_query") return;
    if (!verifyReleaseEvidence(release.evidence, `${details.subject}\n${details.description}`)) return;
    ticketHits += 1;
    await recordReleaseMention({
      watchId: release.watch,
      ticketId: t.id,
      channel: "freshdesk",
      subject: details.subject,
      kind: release.kind,
      quote: release.quote,
      // The sweep timestamps by ticket creation, so the PM list keeps the
      // customer's chronology rather than clustering at backfill time.
      at: Date.parse(t.createdAt) || Date.now(),
    });
  });

  // ── Chats ── (whatever retention still holds; a chat that became a ticket
  // is also swept above — the ticket entry is the canonical one, but a chat
  // that never ticketed only exists here.)
  const conversations = (await listConversations(100).catch(() => [])).filter(
    (c) => c.messages.length > 0 && !c.ticketId,
  );
  let chatHits = 0;
  const chatFailures = await sweep(conversations, async (c) => {
    const firstAsk = c.messages.find((m) => m.author === "visitor")?.text ?? "Live chat";
    const transcript = transcriptText(c);
    const triage = await triageTicket(firstAsk.slice(0, 200), transcript);
    const release = triage.release;
    if (!release || triage.intake !== "customer_query") return;
    if (!verifyReleaseEvidence(release.evidence, transcript)) return;
    chatHits += 1;
    await recordReleaseMention({
      watchId: release.watch,
      ticketId: c.id,
      channel: "jettachat",
      subject: firstAsk.slice(0, 120),
      kind: release.kind,
      quote: release.quote,
      app: c.visitor.app,
      at: Date.parse(c.createdAt) || Date.now(),
    });
  });

  const summary = {
    reset: !!body.reset,
    from,
    to,
    ticketsScanned: tickets.length,
    ticketsTruncated: found.truncated,
    ticketHits,
    ticketFailures,
    chatsScanned: conversations.length,
    chatHits,
    chatFailures,
  };
  await logOpsEvent({
    level: "info",
    event: "release_watch.backfill",
    source: "console",
    actor: "api",
    data: summary,
  });
  return NextResponse.json(summary);
}

/** Wipe the mention store without resweeping. */
export async function DELETE(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await clearReleaseMentions();
  await logOpsEvent({
    level: "info",
    event: "release_watch.cleared",
    source: "console",
    actor: "api",
  });
  return NextResponse.json({ ok: true });
}
