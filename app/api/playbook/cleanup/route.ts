/**
 * Auto-cleanup for the manual test playbook (/testing).
 *
 * The playbook deliberately touches real systems, and its cleanup list used to
 * be entirely manual. This route does the mechanical part: GET scans for what
 * the tests left behind, POST actually cleans it. Two calls on purpose — the
 * tester always sees the exact list before anything irreversible happens.
 *
 * What counts as test debris is deliberately narrow, and every predicate is a
 * marker the playbook rules force testers to leave:
 *   - Freshdesk tickets whose subject carries "[TEST]" (or the exact robot-mail
 *     subject scenario b5 sends), created in the last 14 days, not yet closed.
 *   - Chat conversations started on /chat-demo, or by a @jetpackwork.com
 *     address — the identity testers are told to give.
 *   - Dev-board items whose NAME carries "[TEST]" (the delete side re-checks
 *     the name against the live item before every mutation).
 *
 * The Slack cleanup item stays manual: "the thread your bug escalated to" is
 * not findable by marker, and posting into the wrong thread is worse than a
 * checkbox.
 *
 * Same gate as the rest of the playbook: any signed-in console user. Cleanup
 * is part of the tester's job, not an admin privilege — and everything here is
 * scoped to test artifacts by the predicates above, not by who is asking.
 */
import { NextResponse } from "next/server";
import { gate } from "@/lib/console-auth";
import {
  closeTicket,
  isTerminalStatus,
  searchTickets,
  type TicketSearchRow,
} from "@/lib/tools/freshdesk";
import { deleteTestDevItem, listTestDevItems, type TestDevItem } from "@/lib/tools/monday";
import { listConversations, updateConversation } from "@/lib/chat-store";
import type { ChatConversation } from "@/lib/types";
import { logOpsEvent } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How far back the ticket scan looks. Playbook runs are same-week affairs. */
const SCAN_DAYS = 14;

/** The exact subject scenario b5 ("the robot mail") tells the tester to send. */
const OOO_SUBJECT = "out of office re: your message";

const isTestTicket = (t: TicketSearchRow) =>
  (t.subject.includes("[TEST]") || t.subject.trim().toLowerCase() === OOO_SUBJECT) &&
  !isTerminalStatus(t.status);

const isTestChat = (c: ChatConversation) =>
  c.status !== "resolved" &&
  ((c.pageUrl ?? "").includes("/chat-demo") ||
    (c.visitor.email ?? "").trim().toLowerCase().endsWith("@jetpackwork.com"));

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

export interface CleanupScan {
  tickets: { id: string; subject: string; status: string; url: string }[];
  chats: { id: string; visitor: string; status: string }[];
  monday: { id: string; name: string; url: string }[];
  /** Anything the scan could not cover, said out loud. */
  notes: string[];
}

async function scan(): Promise<CleanupScan> {
  const notes: string[] = [];
  const to = new Date();
  const from = new Date(to.getTime() - SCAN_DAYS * 86_400_000);

  const [ticketsResult, conversations, mondayItems] = await Promise.all([
    searchTickets({ from: dayKey(from), to: dayKey(to) }).catch((e) => {
      notes.push(`Freshdesk scan failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }),
    listConversations(100).catch(() => {
      notes.push("Chat store scan failed.");
      return [] as ChatConversation[];
    }),
    listTestDevItems().catch((e) => {
      notes.push(`Dev-board scan failed: ${e instanceof Error ? e.message : String(e)}`);
      return [] as TestDevItem[];
    }),
  ]);

  if (ticketsResult?.truncated) {
    notes.push("Freshdesk matched more tickets than one scan pages out — run cleanup again after this one.");
  }

  return {
    tickets: (ticketsResult?.tickets ?? []).filter(isTestTicket).map((t) => ({
      id: t.id,
      subject: t.subject,
      status: t.status,
      url: t.url,
    })),
    chats: conversations.filter(isTestChat).map((c) => ({
      id: c.id,
      visitor: c.visitor.name || c.visitor.email || "anonymous",
      status: c.status,
    })),
    monday: mondayItems.map((m) => ({ id: m.id, name: m.name, url: m.url })),
    notes,
  };
}

/** Preview: what a cleanup run WOULD touch. Read-only. */
export async function GET() {
  const { locked } = await gate();
  if (locked) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  return NextResponse.json(await scan());
}

/** Execute: close / resolve / delete everything the scan finds. */
export async function POST() {
  const { locked, user } = await gate();
  if (locked) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const found = await scan();
  const notes = [...found.notes];

  const tickets: { id: string; subject: string; ok: boolean }[] = [];
  for (const t of found.tickets) {
    const ok = await closeTicket(t.id)
      .then(() => true)
      .catch(() => false);
    if (!ok) notes.push(`Ticket #${t.id} refused to close — close it by hand in Freshdesk.`);
    tickets.push({ id: t.id, subject: t.subject, ok });
  }

  const chats: { id: string; ok: boolean }[] = [];
  for (const c of found.chats) {
    const ok = await updateConversation(c.id, { status: "resolved" })
      .then((conv) => conv !== null)
      .catch(() => false);
    chats.push({ id: c.id, ok });
  }

  const monday: { id: string; name: string; ok: boolean; reason?: string }[] = [];
  for (const m of found.monday) {
    const r = await deleteTestDevItem(m.id).catch((e) => ({
      deleted: false,
      reason: e instanceof Error ? e.message : String(e),
    }));
    if (!r.deleted && r.reason) notes.push(`Board item "${m.name}": ${r.reason}.`);
    monday.push({ id: m.id, name: m.name, ok: r.deleted, reason: r.reason });
  }

  await logOpsEvent({
    level: "info",
    event: "playbook.cleanup",
    source: "console",
    actor: user,
    data: {
      tickets: tickets.filter((t) => t.ok).length,
      chats: chats.filter((c) => c.ok).length,
      monday: monday.filter((m) => m.ok).length,
      notes: notes.slice(0, 10),
    },
  });

  return NextResponse.json({ tickets, chats, monday, notes });
}
