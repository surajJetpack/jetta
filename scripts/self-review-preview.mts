/**
 * Preview the /self-review page with production data, without touching prod.
 *
 *   npx tsx --env-file=<env> scripts/self-review-preview.mts [--n 16]
 *
 * Reads production run logs, events and chat transcripts over the admin API
 * (GET only), runs the reliability check and judges up to N replies with the
 * configured judge, then writes the summary to whatever KV the env points at.
 * With .env.local that is the DEV store, so a local `next dev` shows it.
 * Never run it with production KV credentials: it would overwrite the summary
 * the cron writes.
 */
import type { RunLog } from "../lib/kv";
import type { OpsEvent } from "../lib/events";
import type { ChatConversation } from "../lib/types";
import { assessReliability } from "../lib/self-review/reliability";
import { assessActions } from "../lib/self-review/actions";
import { judgeable, judgeModelId } from "../lib/self-review/quality";
import { INCOMPLETE, buildQuality, judgeRun, pickRuns, storeSelfReviewSummary } from "../lib/self-review";
import type { JudgedReply } from "../lib/self-review/types";

const i = process.argv.indexOf("--n");
const N = i > 0 ? Number(process.argv[i + 1]) : 16;
const BASE = "https://jettajetpack.vercel.app";
const H = { "x-admin-secret": process.env.ADMIN_SECRET ?? "" };
if (process.env.KV_REST_API_URL?.includes("knowing-cattle")) throw new Error("That is the production KV. Refusing.");

const get = async <T,>(path: string): Promise<T> => {
  const r = await fetch(`${BASE}${path}`, { headers: H });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return (await r.json()) as T;
};

async function prodContext(l: RunLog): Promise<string> {
  if (l.channel === "jettachat") {
    const j = await get<{ conversation?: ChatConversation }>(`/api/admin/chats?id=${encodeURIComponent(l.ticketId)}`).catch(() => ({ conversation: undefined }));
    return (j.conversation?.messages ?? [])
      .filter((m) => !m.system && Date.parse(m.createdAt) <= l.at * 1000 + 1500)
      .slice(-10)
      .map((m) => `${m.author === "visitor" ? "Customer" : m.via === "human" ? "Human agent" : "Jetta"}: ${m.text}`)
      .join("\n\n")
      .slice(-6000);
  }
  const t = l.trace.find((x) => x.tool === "get_ticket_details");
  return t ? String(t.result).slice(0, 6000) : `${INCOMPLETE}\nSubject: ${l.subject ?? ""}`;
}

const { logs } = await get<{ logs: RunLog[] }>("/api/admin/logs");
const evRes = await get<{ events?: OpsEvent[] }>("/api/admin/events?limit=5000").catch(() => ({ events: [] as OpsEvent[] }));
const events = evRes.events ?? [];
const now = Date.now();
console.log(`${logs.length} runs (${logs.filter(judgeable).length} judgeable), ${events.length} events; judge ${judgeModelId()}`);

const reliability = assessReliability({ beats: {}, logs, events, now });
// Older runs too, for a trend: widen the window the cron would use.
const queue = pickRuns(logs.map((l) => ({ ...l, at: Math.max(l.at, Math.floor(now / 1000) - 30 * 3600) })), [], now, N).map(
  (p) => logs.find((l) => l.id === p.id)!,
);
const judged: JudgedReply[] = [];
const worker = async () => {
  while (queue.length) {
    const l = queue.shift()!;
    try {
      const j = await judgeRun(l, prodContext);
      judged.push(j);
      console.log(`${j.verdict.padEnd(4)} ${j.score}  ${j.kind.padEnd(10)} ${j.summary.slice(0, 140)}`);
    } catch (e) {
      console.log(`FAIL ${l.id}: ${e instanceof Error ? e.message.slice(0, 160) : e}`);
    }
  }
};
await Promise.all([worker(), worker(), worker()]);

await storeSelfReviewSummary({
  computedAt: now,
  reliability,
  quality: buildQuality(judged, now),
  actions: assessActions(logs, now),
  alerts: [],
  settings: { enabled: true, alerts: false, judge: judgeModelId(), dailyCap: 40, channel: "" },
});
console.log(`\nwrote preview summary: ${judged.length} judged, ${reliability.flags.length} flags`);
