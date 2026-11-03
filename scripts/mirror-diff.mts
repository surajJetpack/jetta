// Mirror check: sync recent + known-long tickets, then compare message counts with Freshdesk.
// Usage: npx tsx --env-file=.env.local scripts/mirror-diff.mts   (reads FD, writes only Postgres)
import { syncTicket, mirrorStatus, type FDListTicket } from "../lib/ticket-mirror/sync";
import { fd } from "../lib/tools/freshdesk";
import { getDb, schema } from "../lib/db";
import { eq } from "drizzle-orm";
const db = getDb()!;
const since = new Date(Date.now()-3*86400e3).toISOString();
const list = await fd<FDListTicket[]>(`/tickets?updated_since=${encodeURIComponent(since)}&order_by=updated_at&order_type=desc&per_page=15&include=requester`);
const ids = [...new Set([14549, 14519, 14641, ...list.map(t=>t.id)])].slice(0,18);
const t0 = Date.now();
for (const id of ids) {
  const listed = list.find(t=>t.id===id);
  const r = await syncTicket(id, listed);
  const [row] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, id));
  console.log(id, r, "msgs", row?.messageCount, row?.lastPublicFrom, row?.status, (row?.subject??"").slice(0,40));
}
console.log("secs", Math.round((Date.now()-t0)/1000));
// verify vs FD for 5 tickets
for (const id of ids.slice(0,5)) {
  let n=0; for (let p=1;p<=5;p++){ const b=await fd<unknown[]>(`/tickets/${id}/conversations?per_page=100&page=${p}`); n+=b.length; if(b.length<100)break; }
  const [row] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, id));
  console.log("verify", id, "fd", n+1, "mirror", row?.messageCount, n+1===row?.messageCount ? "OK" : "MISMATCH");
}
// second pass should skip
const again = await syncTicket(ids[3], list.find(t=>t.id===ids[3]));
console.log("resync unchanged ->", again);
console.log(await mirrorStatus());
