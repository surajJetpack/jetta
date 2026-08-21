/**
 * Review outreach: find Freshdesk threads where the customer was genuinely
 * happy, and draft a thank-you + "would you rate us" email onto that same
 * thread as a private note for a human to read and send.
 *
 * monday endorses this exact play — "if a user reaches out for help and has a
 * positive experience, include the review link in your follow-up message" — so
 * the shape of the campaign is theirs, not ours. Three of their constraints
 * drive the code:
 *
 *  - The rating dialog URL is ACCOUNT-SCOPED:
 *      https://<account_slug>.monday.com/apps/installed_apps/<app_id>?openRatingDialog=true
 *    There is no account-agnostic form. A wrong slug lands the customer on an
 *    access error, which is worse than no link at all — so the slug is only
 *    ever taken from evidence in the customer's OWN thread, never guessed, and
 *    a thread with no slug gets a fill-in-your-subdomain template instead.
 *  - Only PAYING monday customers' reviews are publicly counted, and a listing
 *    needs 5 ratings before it shows an average. This is a "clear the
 *    threshold" campaign, not a blast.
 *  - Reviews must be genuine, so nothing here offers an incentive.
 *
 * Why private notes and not drafts: the Freshdesk v2 API has no draft-reply
 * endpoint. `POST /tickets/{id}/reply` sends immediately; `POST /tickets/{id}/notes`
 * is internal-only. Jetta's whole draft mode (lib/drafts.ts) exists for the same
 * reason. A note also can't reopen a resolved ticket, which a reply would — and
 * these are all resolved tickets by construction.
 *
 * Read-only unless --post is passed. Default run writes a report and nothing else.
 *
 *   npx tsx --env-file=.env.local scripts/review-outreach.ts
 *   npx tsx --env-file=.env.local scripts/review-outreach.ts --post
 *
 * Flags: --apps getsign,vlookup  --days 90  --limit 25  --max-threads 250
 *        --out <path>  --post
 */
import fs from "node:fs";
import { generateObject } from "ai";
import { z } from "zod";
import * as freshdesk from "./../lib/tools/freshdesk";
import { appProductFromHint, inferAppProduct } from "../lib/context";
import { parseAccountSlug } from "../lib/tools/monday-monetization";
import { appName, type AppProduct, type Ticket } from "../lib/types";
import { getModel, modelLabel, llmKeyPresent } from "../lib/llm";
import { config } from "../lib/config";
import { logOpsEvent } from "../lib/events";

/**
 * monday marketplace app ids, for the rating-dialog URL. Supplied by the team;
 * GetSign's is confirmed against a live URL, VLOOKUP's is not — override from
 * the env rather than editing this list when a new app joins the campaign.
 */
const APP_IDS: Partial<Record<AppProduct, string>> = {
  getsign: process.env.MONDAY_APP_ID_GETSIGN?.replace(/"/g, "") || "10050849",
  vlookup: process.env.MONDAY_APP_ID_VLOOKUP?.replace(/"/g, "") || "28944",
};

/**
 * Marker written into every note we post, and looked for before posting.
 * Idempotency here is not a nicety: a second "would you rate us" note on a
 * thread reads, to the human sending it, as permission to ask the customer
 * twice. Cheap to check, embarrassing to get wrong.
 */
const NOTE_MARKER = "[jetta:review-request]";

/**
 * Subdomains that appear in monday URLs but are never a customer account:
 * our own docs, our own account, and monday's own hosts. Without this list
 * "support.monday.com" in a help-centre link becomes a customer slug.
 */
const RESERVED_SLUGS = new Set([
  // monday's own hosts. "forms" is the one that bit us: forms.monday.com is a
  // form-submission link, and it sailed through as a customer slug (#13843).
  "www", "support", "auth", "developer", "docs", "help", "community", "api",
  "files", "view", "assets", "start", "forms", "app", "apps", "login", "id",
  "mail", "email", "status", "blog", "monday",
  // ours
  "jetpackteam", "jetpackapps",
  // Placeholders agents type when showing a customer what a URL looks like.
  // "youraccount" reached a finished draft on #13920 before this list existed.
  "youraccount", "your-account", "yourcompany", "your-company", "youraccountname",
  "accountname", "account", "subdomain", "yoursubdomain", "example", "sample",
  "test", "demo", "companyname", "mycompany", "myaccount",
]);

/**
 * Praise the customer typed, not praise we hoped for. Runs on customer messages
 * only, and exists purely to keep the LLM bill down: it is deliberately loose
 * (recall over precision) because the model behind it makes the real call.
 */
const PRAISE = new RegExp(
  [
    "thank(s| you)", "much appreciated", "appreciate (it|that|your|the)",
    "wonderful", "amazing", "awesome", "excellent", "brilliant", "fantastic",
    "perfect", "works (great|perfectly|now)", "great (support|service|work|job|app)",
    "life ?saver", "you (guys |folks )?(rock|are the best)", "love (the app|it|this)",
    "best support", "very helpful", "super helpful", "sorted", "resolved it",
  ].join("|"),
  "i",
);

const Verdict = z.object({
  happy: z
    .boolean()
    .describe("The customer expressed genuine satisfaction with the app or the support they got."),
  confidence: z.enum(["high", "medium", "low"]),
  unresolvedComplaint: z
    .boolean()
    .describe("The thread also contains an unresolved problem, refund request, or churn signal."),
  praiseQuote: z
    .string()
    .describe("The customer's own words, verbatim, up to 20 words. Empty string if none."),
  whatWasSolved: z
    .string()
    .describe(
      "A NOUN PHRASE naming what was resolved, completing the sentence 'we could help with ___'. No verb at the start, no app name, no customer names, no PII. Good: 'the signature reminders that weren't sending'. Bad: 'helping you fix reminders in GetSign'.",
    ),
  activeUser: z
    .boolean()
    .describe(
      "The customer writes as someone already USING the app on a real account — not someone evaluating it before buying, doing a procurement or security review, or asking pre-sales questions.",
    ),
  app: z
    .enum(["getsign", "vlookup", "trackmy", "extract", "jobflows", "smartcolumns", "jetscan", "pivotreports", "triggerly", "unknown"])
    .describe("Which app the thread is about."),
});
type Verdict = z.infer<typeof Verdict>;

const SYSTEM = `You read a resolved support thread and decide whether the customer ended it genuinely happy.

Say happy=true ONLY when the customer themselves expressed satisfaction after their problem was handled. Be strict:
- "thanks" as a sign-off on a question they are still waiting on is NOT satisfaction.
- "thanks, but it still doesn't work" is NOT satisfaction.
- Praise followed by a new problem is NOT satisfaction; set unresolvedComplaint=true.
- An agent saying the issue is resolved is not the customer saying so.

These threads are used to decide who gets asked for a public app review, so a false positive means asking an unhappy customer to rate us. When in doubt, happy=false.`;

interface Candidate {
  ticketId: string;
  subject: string;
  url: string;
  status: string;
  requesterName: string | null;
  requesterEmail: string;
  app: AppProduct;
  /** Slug taken from a monday URL the customer themselves pasted, or null. */
  slug: string | null;
  slugSource: string | null;
  lastCustomerAt: string;
  verdict: Verdict;
  alreadyAsked: boolean;
  subjectLine: string;
  body: string;
  reviewUrl: string | null;
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Freshdesk's filter API pages out at most 300 matches per query, so a 90-day
 * window asked for in one go silently returns a slice. Slicing the window
 * instead keeps every chunk comfortably under the cap; searchTickets reports
 * `truncated` per chunk so a chunk that still overflows is visible rather than
 * quietly short.
 */
function windows(days: number, chunkDays = 10): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  const end = new Date();
  for (let offset = 0; offset < days; offset += chunkDays) {
    const to = new Date(end.getTime() - offset * 86_400_000);
    const from = new Date(end.getTime() - Math.min(offset + chunkDays - 1, days - 1) * 86_400_000);
    out.push({ from: dayKey(from), to: dayKey(to) });
  }
  return out;
}

/** The customer's own messages, oldest first — the only evidence of sentiment. */
function customerMessages(t: Ticket): { body: string; at: string }[] {
  return t.replies
    .filter((r) => r.author === "customer" && !r.isPrivate)
    .map((r) => ({ body: r.body, at: r.createdAt }));
}

/** Every non-reserved monday slug in a blob of text, with hit counts. */
function slugsIn(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of text.matchAll(/https?:\/\/([a-z0-9][a-z0-9-]*)\.monday\.com/gi)) {
    const slug = parseAccountSlug(raw[0])?.toLowerCase();
    if (slug && !RESERVED_SLUGS.has(slug)) counts.set(slug, (counts.get(slug) ?? 0) + 1);
  }
  return counts;
}

const topSlug = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0];

/**
 * The customer's monday account slug, from monday URLs somebody pasted into the
 * thread. Ranked by how much the source can be trusted, because a wrong slug
 * sends the customer to an access error — worse than shipping no link at all:
 *
 *   1. the customer's own messages — they can only link their own account;
 *   2. an agent's messages — usually the customer's board, but sometimes ours
 *      or a help-centre page, so it is labelled for the reviewer to eyeball.
 *
 * RESERVED_SLUGS keeps our own account and monday's own hosts out of both.
 */
function extractSlug(t: Ticket): { slug: string; source: string } | null {
  const mine = topSlug(slugsIn(customerMessages(t).map((m) => m.body).join("\n")));
  if (mine) return { slug: mine[0], source: `the customer's own message (${mine[1]}×)` };

  const theirs = topSlug(
    slugsIn(t.replies.filter((r) => r.author === "agent").map((r) => r.body).join("\n")),
  );
  return theirs
    ? { slug: theirs[0], source: `an AGENT message (${theirs[1]}×) — please verify` }
    : null;
}

/**
 * The slug from Freshdesk's own `account_url` contact field — the one place
 * actually built to hold it. Empty on every contact sampled on 2026-08-20, so
 * this exists to pay off the day the team starts filling it in, not to carry the
 * campaign today. Best-effort: a miss falls through to thread evidence.
 */
async function contactSlug(email: string): Promise<{ slug: string; source: string } | null> {
  try {
    const q = encodeURIComponent(`"email:'${email.replace(/'/g, "")}'"`);
    const res = await freshdesk.fd<{ results?: { custom_fields?: Record<string, unknown> }[] }>(
      `/search/contacts?query=${q}`,
    );
    const url = res.results?.[0]?.custom_fields?.account_url;
    const slug = typeof url === "string" ? parseAccountSlug(url)?.toLowerCase() : null;
    return slug && !RESERVED_SLUGS.has(slug)
      ? { slug, source: "the contact's Account URL field" }
      : null;
  } catch {
    return null;
  }
}

function reviewUrlFor(app: AppProduct, slug: string | null): string | null {
  const appId = APP_IDS[app];
  if (!appId || !slug) return null;
  return `https://${slug}.monday.com/apps/installed_apps/${appId}?openRatingDialog=true`;
}

function firstName(name: string | null): string {
  const n = (name ?? "").trim().split(/\s+/)[0];
  return /^[A-Za-z][A-Za-z'’-]{1,}$/.test(n) ? n : "there";
}

/**
 * The email itself. A fixed template with one model-written clause, rather than
 * a model-written email: the ask is identical for everyone, and the only part
 * worth personalising is the reminder of what we actually did for them. Keeps
 * every draft consistent, on-message, and reviewable at a glance.
 */
function compose(c: Omit<Candidate, "subjectLine" | "body" | "reviewUrl">, signature: string) {
  const app = appName(c.app);
  const appId = APP_IDS[c.app];
  const url = reviewUrlFor(c.app, c.slug);

  const link = url
    ? `${url}\n\nThat link opens the rating box straight away — no hunting required.`
    : `In monday, open the Apps icon in the left sidebar → Installed apps → ${app} → Rate this app.\n\n` +
      `Or paste this into your browser, swapping in your own monday subdomain:\n` +
      `https://YOUR-ACCOUNT.monday.com/apps/installed_apps/${appId ?? "APP_ID"}?openRatingDialog=true`;

  const solved = c.verdict.whatWasSolved.trim().replace(/\.$/, "");

  return {
    subjectLine: `Thank you — and a small favour, from the ${app} team`,
    body:
      `Hi ${firstName(c.requesterName)},\n\n` +
      `Thanks so much for your kind words${solved ? ` — I'm really glad we could help with ${solved}` : ""}.\n\n` +
      `If ${app} has been useful to you, would you consider leaving us a rating and a few words ` +
      `on the monday marketplace? We're a small team and reviews are far and away the biggest ` +
      `thing that helps other monday users find us. It takes under a minute.\n\n` +
      `${link}\n\n` +
      `Either way, thank you for using ${app} — and just reply here whenever you need us.\n\n` +
      `Best,\n${signature.replace("{app}", app)}`,
    reviewUrl: url,
  };
}

function noteFor(c: Candidate): string {
  const lines = [
    `${NOTE_MARKER} Suggested review-request email — review, then copy into a reply.`,
    "",
    `App: ${appName(c.app)}`,
    `Review link: ${c.reviewUrl ?? "NOT RESOLVED — the email falls back to click-path instructions"}`,
    `monday account slug: ${c.slug ? `${c.slug} (from ${c.slugSource})` : "unknown"}`,
    `Why this thread: ${c.verdict.confidence} confidence${c.verdict.praiseQuote ? ` — customer said: "${c.verdict.praiseQuote}"` : ""}`,
    "",
    `Subject: ${c.subjectLine}`,
    "",
    c.body,
    "",
    "— Drafted by scripts/review-outreach.ts. Nothing was sent to the customer.",
  ];
  return lines.join("\n");
}

async function main() {
  const days = Number(arg("days", "90"));
  const limit = Number(arg("limit", "25"));
  const maxThreads = Number(arg("max-threads", "250"));
  const signature = arg("signature", "The {app} team");
  const post = has("post");
  const apps = new Set(
    (arg("apps", "getsign,vlookup") ?? "").split(",").map((s) => s.trim()).filter(Boolean) as AppProduct[],
  );
  const out = arg("out", "/tmp/review-outreach.json")!;

  if (!config.freshdesk.live) {
    console.warn("FRESHDESK_LIVE is not true — running against stubs, results are meaningless.");
  }
  if (!llmKeyPresent()) throw new Error("No LLM API key for the configured provider.");
  for (const a of apps) {
    if (!APP_IDS[a]) console.warn(`No monday app id for "${a}" — its emails will use the fallback instructions.`);
  }

  console.log(
    `Scanning ${days} days for happy ${[...apps].map(appName).join(" / ")} threads ` +
      `(model ${modelLabel("light")}, ${post ? "WILL POST notes" : "dry run"}).`,
  );

  // 1. Every ticket created in the window, chunked under Freshdesk's 300-per-query cap.
  const rows: freshdesk.TicketSearchRow[] = [];
  for (const w of windows(days)) {
    const r = await freshdesk.searchTickets(w);
    if (r.truncated) console.warn(`  ${w.from}..${w.to}: TRUNCATED — some tickets not seen.`);
    rows.push(...r.tickets);
  }
  const unique = [...new Map(rows.map((r) => [r.id, r])).values()];
  console.log(`  ${unique.length} tickets in window.`);

  // 2. Cheap narrowing before any thread fetch. Terminal status only: an open
  //    ticket has no happy ending yet, and cf_product (when agents set it) rules
  //    out other apps without spending a request.
  const shortlist = unique
    .filter((r) => freshdesk.isTerminalStatus(r.status))
    .filter((r) => {
      const hinted = appProductFromHint(r.product);
      return hinted ? apps.has(hinted) : true; // unset hint → decide from the thread
    })
    .slice(0, maxThreads);
  console.log(`  ${shortlist.length} resolved/closed candidates to read.`);

  // 3. Read each thread; regex-prefilter; LLM-judge the survivors.
  const candidates: Candidate[] = [];
  let read = 0;
  let prefiltered = 0;
  let judged = 0;

  // Freshdesk rate-limits per minute, and each thread costs ~2 requests (the
  // ticket plus its conversations, plus a contact lookup for finalists). At
  // 350ms this run spent most of its wall clock inside 30s Retry-After waits;
  // ~1.2s keeps it under ~100 requests/min, which is strictly faster overall.
  // Raise it with --pace-ms if the account is on a lower tier.
  const pace = Number(arg("pace-ms", "1200"));

  for (const row of shortlist) {
    read++;
    if (read > 1 && pace > 0) await new Promise((r) => setTimeout(r, pace));
    let ticket: Ticket;
    try {
      ticket = await freshdesk.getTicketDetails(row.id);
    } catch (e) {
      console.warn(`  #${row.id}: ${e instanceof Error ? e.message : e}`);
      continue;
    }

    const msgs = customerMessages(ticket);
    if (!msgs.length) continue;
    if (!msgs.some((m) => PRAISE.test(m.body))) continue;
    prefiltered++;

    const app =
      appProductFromHint(ticket.productHint) ??
      inferAppProduct(`${ticket.subject}\n${ticket.description}`);

    const transcript = [
      `Subject: ${ticket.subject}`,
      `Opening message (customer): ${ticket.description.slice(0, 2000)}`,
      ...ticket.replies
        .filter((r) => !r.isPrivate)
        .map((r) => `${r.author === "customer" ? "Customer" : "Agent"}: ${r.body.slice(0, 1200)}`),
    ].join("\n\n");

    let verdict: Verdict;
    try {
      const res = await generateObject({
        model: getModel("light"),
        schema: Verdict,
        system: SYSTEM,
        prompt: transcript,
      });
      verdict = res.object;
      judged++;
    } catch (e) {
      console.warn(`  #${row.id}: judge failed — ${e instanceof Error ? e.message : e}`);
      continue;
    }

    // The judge's app read beats the regex when the regex found nothing.
    const finalApp = app !== "unknown" ? app : (verdict.app as AppProduct);
    if (!apps.has(finalApp)) continue;
    // monday only counts reviews from paying customers, and someone still
    // evaluating the app has nothing to review — both are wasted asks.
    if (!verdict.happy || verdict.unresolvedComplaint || verdict.confidence === "low") continue;
    if (!verdict.activeUser) {
      console.log(`  – #${ticket.id} happy but reads as an evaluator, not a user — skipped.`);
      continue;
    }
    if (!ticket.requesterEmail) continue;

    const slug = extractSlug(ticket);
    const base = {
      ticketId: ticket.id,
      subject: ticket.subject,
      url: freshdesk.freshdeskTicketUrl(ticket.id),
      status: ticket.status,
      requesterName: ticket.requesterName,
      requesterEmail: ticket.requesterEmail,
      app: finalApp,
      slug: slug?.slug ?? null,
      slugSource: slug?.source ?? null,
      lastCustomerAt: msgs[msgs.length - 1].at,
      verdict,
      alreadyAsked: ticket.replies.some((r) => r.isPrivate && r.body.includes(NOTE_MARKER)),
    };
    candidates.push({ ...base, ...compose(base, signature!) });
    console.log(
      `  ✓ #${ticket.id} ${appName(finalApp)} — ${verdict.confidence}` +
        `${base.slug ? ` — slug ${base.slug}` : " — no slug"}${base.alreadyAsked ? " — ALREADY ASKED" : ""}`,
    );
  }

  // 4. One ask per person, on their most recent happy thread. A customer with
  //    three delighted tickets is one review, not three emails.
  const byEmail = new Map<string, Candidate>();
  for (const c of [...candidates].sort((a, b) => b.lastCustomerAt.localeCompare(a.lastCustomerAt))) {
    const key = c.requesterEmail.toLowerCase();
    if (!byEmail.has(key)) byEmail.set(key, c);
  }
  const finalists = [...byEmail.values()].filter((c) => !c.alreadyAsked).slice(0, limit);

  // A slug appearing on several unrelated customers' tickets is not a customer
  // slug — it is a template an agent reuses, or one of our own accounts that
  // RESERVED_SLUGS does not know about yet. Catches the next "youraccount"
  // without waiting for it to reach a customer.
  const slugUses = new Map<string, number>();
  for (const c of finalists) if (c.slug) slugUses.set(c.slug, (slugUses.get(c.slug) ?? 0) + 1);
  for (const c of finalists) {
    if (c.slug && (slugUses.get(c.slug) ?? 0) >= 3) {
      console.warn(`  ! slug "${c.slug}" seen on ${slugUses.get(c.slug)} tickets — treating as a template, dropping.`);
      c.slug = null;
      c.slugSource = null;
    }
  }

  // Freshdesk's own Account URL field outranks anything scraped from the thread,
  // so give the shortlist one chance to upgrade. Finalists only: it costs a
  // request each, and it is pointless for candidates nobody will email.
  for (const c of finalists) {
    const fromContact = await contactSlug(c.requesterEmail);
    if (fromContact) {
      c.slug = fromContact.slug;
      c.slugSource = fromContact.source;
    }
    // Recompose unconditionally: the slug may have been upgraded above, or
    // dropped by the template guard, and a stale body would still carry the
    // old link.
    const recomposed = compose(c, signature!);
    c.body = recomposed.body;
    c.reviewUrl = recomposed.reviewUrl;
  }

  // 5. Post (opt-in) and report.
  let posted = 0;
  if (post) {
    for (const c of finalists) {
      try {
        await freshdesk.addPrivateNote(c.ticketId, noteFor(c));
        posted++;
        await logOpsEvent({
          level: "info",
          event: "review_outreach.drafted",
          source: "app",
          ticketId: c.ticketId,
          actor: "review-outreach-script",
          data: { app: c.app, hasReviewUrl: !!c.reviewUrl, confidence: c.verdict.confidence },
        });
      } catch (e) {
        console.warn(`  post failed #${c.ticketId}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  const perApp = finalists.reduce<Record<string, number>>((acc, c) => {
    acc[appName(c.app)] = (acc[appName(c.app)] ?? 0) + 1;
    return acc;
  }, {});

  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        window: { days },
        model: modelLabel("light"),
        counts: {
          ticketsInWindow: unique.length,
          threadsRead: read,
          passedPraiseFilter: prefiltered,
          judged,
          happy: candidates.length,
          uniquePeople: byEmail.size,
          alreadyAsked: candidates.filter((c) => c.alreadyAsked).length,
          drafted: finalists.length,
          withReviewLink: finalists.filter((c) => c.reviewUrl).length,
          posted,
        },
        perApp,
        drafts: finalists,
      },
      null,
      2,
    ),
  );

  console.log(
    `\nRead ${read} threads → ${prefiltered} mentioned praise → ${judged} judged → ` +
      `${candidates.length} genuinely happy → ${finalists.length} drafts ` +
      `(${finalists.filter((c) => c.reviewUrl).length} with a working review link).`,
  );
  console.log(`Per app: ${Object.entries(perApp).map(([a, n]) => `${a} ${n}`).join(", ") || "none"}`);
  console.log(post ? `Posted ${posted} private notes.` : "Dry run — no notes posted. Re-run with --post.");
  console.log(`Report: ${out}`);
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
