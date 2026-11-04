/**
 * Calibrate the self-review judge on real production runs, read-only.
 *
 *   npx tsx --env-file=<env> scripts/self-review-calibrate.ts [--n 12] [--models a,b]
 *
 * Pulls recent run logs and chat transcripts from the production admin API
 * (GET only, with ADMIN_SECRET), judges each reply with every model given,
 * and prints the verdicts side by side with their agreement, so a judge is
 * trusted only after it agrees with a second one (and a person spot-checks
 * the disagreements). Writes nothing anywhere; results go to stdout and
 * .self-review-calibration.json.
 */
import { writeFileSync } from "node:fs";
import type { RunLog } from "../lib/kv";
import type { ChatConversation } from "../lib/types";
import { evidenceFromTrace, judgeReply, judgeable, kindOf, replyOf, ruleChecks, finalVerdict } from "../lib/self-review/quality";

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const N = Number(arg("n", "12"));
const MODELS = arg("models", "moonshotai/kimi-k3.1-pro,qwen/qwen3.8-max-0902").split(",");
const BASE = process.env.SELF_REVIEW_BASE ?? "https://jettajetpack.vercel.app";
const H = { "x-admin-secret": process.env.ADMIN_SECRET ?? "" };

async function chatAsk(id: string, beforeMs: number): Promise<string> {
  const r = await fetch(`${BASE}/api/admin/chats?id=${encodeURIComponent(id)}`, { headers: H });
  if (!r.ok) return "";
  const j = (await r.json()) as { conversation?: ChatConversation };
  const msgs = (j.conversation?.messages ?? []).filter((m) => !m.system && Date.parse(m.createdAt) <= beforeMs);
  return msgs
    .slice(-10)
    .map((m) => `${m.author === "visitor" ? "Customer" : m.via === "human" ? "Human agent" : "Jetta"}: ${m.text}`)
    .join("\n\n")
    .slice(-5000);
}

function ticketAsk(l: RunLog): string {
  const t = l.trace.find((x) => x.tool === "get_ticket_details");
  return t ? String(t.result).slice(0, 5000) : `Subject: ${l.subject ?? ""}`;
}

async function main() {
  const r = await fetch(`${BASE}/api/admin/logs`, { headers: H });
  const { logs } = (await r.json()) as { logs: RunLog[] };
  const pick = logs.filter(judgeable);
  // A spread: chats and emails alternately.
  const chats = pick.filter((l) => kindOf(l) === "chat");
  const other = pick.filter((l) => kindOf(l) !== "chat");
  const sample: RunLog[] = [];
  for (let i = 0; sample.length < N && (i < chats.length || i < other.length); i++) {
    if (chats[i]) sample.push(chats[i]);
    if (other[i] && sample.length < N) sample.push(other[i]);
  }
  console.log(`${logs.length} runs, ${pick.length} judgeable, sampling ${sample.length}; judges: ${MODELS.join(", ")}\n`);

  const rows: unknown[] = [];
  let agree = 0;
  for (const l of sample) {
    const kind = kindOf(l);
    const reply = replyOf(l)!;
    const customerAsk = kind === "chat" ? await chatAsk(l.ticketId, l.at * 1000 + 1500) : ticketAsk(l);
    const evidence = evidenceFromTrace({ trace: l.trace as never }, 9000);
    const checks = await ruleChecks(kind, reply, evidence, customerAsk);
    const out: Record<string, unknown> = {};
    for (const m of MODELS) {
      const t0 = Date.now();
      try {
        const j = await judgeReply({ kind, app: l.app, subject: l.subject, customerAsk, evidence, reply, escalated: l.escalated }, m);
        out[m] = { ...finalVerdict(j, checks), summary: j.summary, answered: j.answered, grounded: j.grounded, ms: Date.now() - t0 };
      } catch (e) {
        out[m] = { error: e instanceof Error ? e.message.slice(0, 200) : String(e), ms: Date.now() - t0 };
      }
    }
    const verdicts = MODELS.map((m) => (out[m] as { verdict?: string }).verdict ?? "ERR");
    if (new Set(verdicts).size === 1) agree++;
    console.log(`[${kind}] ${l.ticketId} ${l.subject?.slice(0, 50) ?? ""}  checks=${checks.join("|") || "-"}`);
    for (const m of MODELS) {
      const o = out[m] as { verdict?: string; score?: number; summary?: string; error?: string; ms: number; fixType?: string };
      console.log(`   ${m.padEnd(32)} ${o.error ? `ERROR ${o.error}` : `${o.verdict} ${o.score}  ${o.fixType}  (${Math.round(o.ms / 1000)}s)  ${o.summary}`}`);
    }
    rows.push({ runId: l.id, ticketId: l.ticketId, kind, reply, customerAsk: customerAsk.slice(0, 1500), checks, out });
  }
  console.log(`\nverdict agreement: ${agree}/${sample.length}`);
  writeFileSync(".self-review-calibration.json", JSON.stringify(rows, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
