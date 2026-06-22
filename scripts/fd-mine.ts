/**
 * Mine recent RESOLVED Freshdesk tickets for the "learn from agents" analysis.
 * Read-only. Redacts PII (emails, phones, monday/freshdesk URLs, greeting names)
 * before anything is written, and trims each ticket to the customer problem +
 * the agent's resolution. Output: /tmp/fd-mined.json (local, never committed).
 *
 *   FRESHDESK_API_KEY=... FRESHDESK_DOMAIN=... TARGET=150 npx tsx scripts/fd-mine.ts
 */
import fs from "node:fs";

const KEY = process.env.FRESHDESK_API_KEY!;
const DOM = process.env.FRESHDESK_DOMAIN!;
const TARGET = Number(process.env.TARGET ?? 150);
const SINCE = process.env.SINCE ?? "2026-04-22T00:00:00Z";
const auth = "Basic " + Buffer.from(`${KEY}:X`).toString("base64");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fd<T>(path: string): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`https://${DOM}/api/v2${path}`, { headers: { Authorization: auth } });
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after") ?? 5);
      console.error(`  rate-limited, waiting ${wait}s…`);
      await sleep((wait + 1) * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${path}`);
    return (await res.json()) as T;
  }
  throw new Error(`gave up on ${path}`);
}

function strip(html: string): string {
  return (html || "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").trim();
}

const NAME = "[A-Z][a-zA-Z'’.-]+(?:\\s+[A-Z][a-zA-Z'’.-]+){0,2}";
function redact(s: string): string {
  return (s || "")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[EMAIL]")
    .replace(/https?:\/\/[\w-]+\.monday\.com\S*/gi, "[ACCOUNT_URL]")
    .replace(/https?:\/\/[\w.-]+\.freshdesk\.com\S*/gi, "[FD_URL]")
    .replace(/(\+?\d[\d\s().-]{8,}\d)/g, "[PHONE]")
    // greetings: "Hi First Last," → "Hi [NAME],"
    .replace(new RegExp(`\\b(Hi|Hello|Hey|Dear)\\b[ ,]+${NAME}`, "g"), "$1 [NAME]")
    // sign-offs: "Best regards, First Last" / "Thanks, Gabriel" → "..., [NAME]"
    .replace(new RegExp(`\\b(Thanks|Thank you|Regards|Best regards|Best|Sincerely|Cheers|Kind regards|Warm regards|Br)\\b[ ,]*\\n*\\s*${NAME}`, "g"), "$1, [NAME]")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function redactSubject(s: string): string {
  // "Conversation with <name>" and "<name> has joined your team" carry names.
  return redact((s || "").replace(/^(Conversation with)\b.*/i, "$1 [NAME]"));
}

function isNoise(subject: string): boolean {
  return /joined your team|has joined|out of office/i.test(subject);
}

async function main() {
  const FETCH_CAP = Number(process.env.FETCH_CAP ?? 450);
  // 1. Collect closed/resolved ticket ids in the window.
  type LT = { id: number; status: number; created_at: string };
  const ids: number[] = [];
  for (let page = 1; page <= 12 && ids.length < FETCH_CAP; page++) {
    const list = await fd<LT[]>(`/tickets?updated_since=${SINCE}&per_page=100&page=${page}&order_by=created_at&order_type=desc`);
    if (!list.length) break;
    for (const t of list) if ([4, 5].includes(t.status)) ids.push(t.id);
    await sleep(250);
  }
  console.error(`scanning up to ${Math.min(ids.length, FETCH_CAP)} resolved tickets for ${TARGET} substantive ones…`);

  // 2. Fetch each with conversations; redact + trim; keep only substantive ones.
  type Conv = { body_text?: string; body?: string; private: boolean; incoming: boolean };
  type Ticket = { id: number; subject: string; description_text?: string; description?: string; status: number; created_at: string; tags?: string[]; conversations?: Conv[] };
  const out: unknown[] = [];
  let scanned = 0;
  for (const id of ids) {
    if (out.length >= TARGET || scanned >= FETCH_CAP) break;
    scanned++;
    try {
      const t = await fd<Ticket>(`/tickets/${id}?include=conversations`);
      if (isNoise(t.subject || "")) continue;
      const convos = t.conversations ?? [];
      const agentReplies = convos.filter((c) => !c.incoming && !c.private).map((c) => strip(c.body_text ?? c.body ?? ""));
      const resolution = redact(agentReplies.slice(-2).join("\n---\n")).slice(0, 1800);
      if (resolution.length < 40) continue; // skip tickets with no real agent resolution
      out.push({
        id: t.id,
        subject: redactSubject(t.subject || ""),
        problem: redact(strip(t.description_text ?? t.description ?? "")).slice(0, 1200),
        resolution,
        tags: t.tags ?? [],
        createdAt: t.created_at,
      });
    } catch (e) {
      console.error(`  skip #${id}: ${e instanceof Error ? e.message : e}`);
    }
    if (scanned % 25 === 0) console.error(`  scanned ${scanned}, kept ${out.length}`);
    await sleep(280);
  }

  fs.writeFileSync("/tmp/fd-mined.json", JSON.stringify(out, null, 2));
  console.error(`scanned ${scanned}, kept ${out.length} substantive`);
  console.error(`\nwrote ${out.length} tickets to /tmp/fd-mined.json`);
  // tiny preview (redacted) to confirm
  console.error("sample subjects:", (out as { subject: string }[]).slice(0, 8).map((x) => x.subject));
}

main().catch((e) => { console.error("ERROR:", e); process.exit(1); });
