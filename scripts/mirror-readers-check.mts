// Side-by-side check: the mirror readers (today, reconcile, perf-sync) against
// the Freshdesk reads they replace. Reads FD; writes only Postgres (one sync tick).
// Usage: npx tsx --env-file=.env.local scripts/mirror-readers-check.mts
import { runTicketSync } from "../lib/ticket-mirror/sync";
import { mirrorTicketState, mirrorAgentReplyAfter, mirrorConversations, mirrorAsOf } from "../lib/ticket-mirror/read";
import { awaitsOurReply, fd, getAgentReplyAfter, getTicketDetails } from "../lib/tools/freshdesk";
import { summarizeTicket, type PerfConversation, type PerfListTicket } from "../lib/performance";
import { getDb, schema } from "../lib/db";
import { desc } from "drizzle-orm";

await runTicketSync(40_000); // make sure the mirror is "live"
console.log("mirror as of", new Date((await mirrorAsOf()) ?? 0).toISOString());
const rows = await getDb()!.select().from(schema.tickets).orderBy(desc(schema.tickets.updatedAt)).limit(10);
let ok = 0, bad = 0;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
for (const r of rows) {
  const id = String(r.id);
  const t = await getTicketDetails(id);
  const fdState = { status: t.status, awaitingReply: awaitsOurReply(t) };
  const mState = await mirrorTicketState(id);
  const since = new Date(Date.parse(r.createdAt) + 60_000).toISOString();
  const fdReply = await getAgentReplyAfter(id, since);
  const mReply = await mirrorAgentReplyAfter(id, since);
  const fdThread: PerfConversation[] = [];
  for (let p = 1; p <= 5; p++) { const b = await fd<PerfConversation[]>(`/tickets/${id}/conversations?per_page=100&page=${p}`); fdThread.push(...b); if (b.length < 100) break; }
  const mThread = (await mirrorConversations(r.id, { requireUpdatedAt: r.updatedAt }))?.conversations;
  const base = { id: r.id, subject: r.subject, source: r.source, status: r.status, created_at: r.createdAt, updated_at: r.updatedAt } as unknown as PerfListTicket;
  const agents = new Map<number, string>();
  const sFd = summarizeTicket(base, fdThread, agents, null);
  const sM = mThread ? summarizeTicket(base, mThread, agents, null) : null;
  const checks = {
    state: same(fdState, mState),
    reply: same(fdReply && { ...fdReply, body: fdReply.body.trim() }, mReply && { ...mReply, body: mReply.body.trim() }),
    perf: same(sFd, sM),
  };
  const pass = Object.values(checks).every(Boolean);
  if (pass) ok++; else bad++;
  console.log(id, pass ? "OK" : "DIFF", checks, pass ? "" : { fdState, mState, fdReplyAt: fdReply?.createdAt, mReplyAt: mReply?.createdAt });
}
console.log({ ok, bad });
