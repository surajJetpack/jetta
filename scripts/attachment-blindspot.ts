/**
 * How often does Jetta answer a ticket without seeing a screenshot on it?
 *
 * JettaChat runs a vision pass on every uploaded image and puts the description
 * in the prompt. The Freshdesk path does not: `ticket.attachments` is populated
 * and used only to forward files onto the dev board at escalation time, so on
 * an email ticket the model is never told an image exists at all.
 *
 * This measures the size of that gap over tickets Jetta actually handled,
 * rather than over the whole helpdesk — the question is how often it bites,
 * not how many files exist.
 *
 *   npx tsx --env-file=.env.local scripts/attachment-blindspot.ts [--limit 150]
 *
 * Read-only. One Freshdesk GET per ticket.
 *
 * Caveat carried into the output: ?include=conversations embeds only the first
 * ten conversations, so an image attached late in a long thread is invisible
 * here too. Every number below is therefore a FLOOR.
 */
import { getOutcomes } from "../lib/kv";

const arg = (name: string, dflt: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : Number(process.argv[i + 1]);
};
const LIMIT = arg("limit", 150);

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|heic|tiff?)$/i;
const DOC = /\.(pdf|docx?|xlsx?|csv|txt|eml|msg|pptx?)$/i;
const VIDEO = /\.(mp4|mov|avi|mkv|webm|m4v)$/i;

interface FDAttachment {
  name: string;
  content_type?: string;
  size?: number;
}

async function main() {
  const domain = process.env.FRESHDESK_DOMAIN ?? "jetpackwork.freshdesk.com";
  const key = process.env.FRESHDESK_API_KEY;
  if (!key) throw new Error("FRESHDESK_API_KEY is not set");
  const auth = "Basic " + Buffer.from(`${key}:X`).toString("base64");

  const outcomes = await getOutcomes(1000);
  const tickets = [
    ...new Set(
      outcomes
        .filter((o) => o.channel === "freshdesk")
        .sort((a, b) => b.at - a.at)
        .map((o) => o.ticketId),
    ),
  ].slice(0, LIMIT);

  console.log(`Checking ${tickets.length} tickets Jetta ran on (newest first).\n`);

  let withAny = 0;
  let withImage = 0;
  let withDocOnly = 0;
  let withVideo = 0;
  const imageTickets: { id: string; subject: string; names: string[] }[] = [];
  let checked = 0;
  let oldest = Infinity;
  let newest = 0;

  for (const id of tickets) {
    let res = await fetch(`https://${domain}/api/v2/tickets/${id}?include=conversations`, {
      headers: { Authorization: auth },
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after") ?? 30);
      process.stdout.write(`\n  rate limited — waiting ${wait}s\n`);
      await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
      res = await fetch(`https://${domain}/api/v2/tickets/${id}?include=conversations`, {
        headers: { Authorization: auth },
      });
    }
    if (!res.ok) continue;
    const t = (await res.json()) as {
      subject: string;
      created_at: string;
      attachments?: FDAttachment[];
      conversations?: { incoming?: boolean; attachments?: FDAttachment[] }[];
    };
    checked++;
    const created = Date.parse(t.created_at);
    oldest = Math.min(oldest, created);
    newest = Math.max(newest, created);

    // Customer-sent only: an agent's own attachment is not something Jetta
    // needed to read in order to answer.
    const files: FDAttachment[] = [
      ...(t.attachments ?? []),
      ...(t.conversations ?? []).filter((c) => c.incoming).flatMap((c) => c.attachments ?? []),
    ];
    if (!files.length) continue;
    withAny++;

    const names = files.map((f) => f.name);
    const imgs = names.filter((n) => IMAGE.test(n));
    if (imgs.length) {
      withImage++;
      imageTickets.push({ id, subject: t.subject, names: imgs });
    } else if (names.some((n) => VIDEO.test(n))) withVideo++;
    else if (names.some((n) => DOC.test(n))) withDocOnly++;

    if (checked % 25 === 0) process.stdout.write(`  …${checked}\n`);
  }

  const pc = (n: number) => `${((n / checked) * 100).toFixed(0)}%`;
  console.log(`\n─── ${checked} tickets checked ───`);
  console.log(
    `window: ${new Date(oldest).toISOString().slice(0, 10)} → ${new Date(newest).toISOString().slice(0, 10)}\n`,
  );
  console.log(`  any customer file      ${String(withAny).padStart(3)}  ${pc(withAny)}`);
  console.log(`  IMAGE (the blind spot) ${String(withImage).padStart(3)}  ${pc(withImage)}`);
  console.log(`  video only             ${String(withVideo).padStart(3)}  ${pc(withVideo)}`);
  console.log(`  document only          ${String(withDocOnly).padStart(3)}  ${pc(withDocOnly)}`);
  console.log(
    `\nFloor, not a count: ?include=conversations embeds only the first ten\n` +
      `conversations, so images later in a long thread are missed here too.\n`,
  );

  if (imageTickets.length) {
    console.log("Tickets where an image was sent and never seen:");
    for (const t of imageTickets.slice(0, 20)) {
      console.log(`  #${t.id}  ${t.subject.slice(0, 58).padEnd(58)} ${t.names.slice(0, 3).join(", ")}`);
    }
    if (imageTickets.length > 20) console.log(`  …and ${imageTickets.length - 20} more`);
  }
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
