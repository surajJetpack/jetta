// One ticket-sync tick from a terminal (same code as /api/cron/ticket-sync).
// Usage: npx tsx --env-file=.env.local scripts/ticket-sync-once.mts [seconds=60]
import { runTicketSync, mirrorStatus } from "../lib/ticket-mirror/sync";
const secs = Number(process.argv[2] ?? 60);
console.log(JSON.stringify(await runTicketSync(secs * 1000), null, 1));
console.log(await mirrorStatus());
