/**
 * One chat, one ticket — shown in full.
 *
 * Answers the question "what does a ticket made from a chat actually carry?"
 * by building a realistic conversation, running it through the REAL hand-off
 * (`openTicketForConversation`, the same function Jetta's create_support_ticket
 * tool and the console's convert button both call) and printing every byte
 * Freshdesk receives.
 *
 *   npx tsx --env-file=.env.local scripts/chat-ticket-scenario.ts
 *   npx tsx --env-file=.env.local scripts/chat-ticket-scenario.ts --live
 *
 * Flags:
 *   --live     open a REAL ticket in Freshdesk and print its URL. Without this
 *              nothing leaves the machine: Freshdesk's HTTP calls are captured
 *              and printed instead of sent.
 *   --keep     --live only: don't delete the ticket afterwards. Implied when
 *              you want to look at it in the Freshdesk UI, which is the point.
 *   --no-files skip the attachment, and with it the blob write.
 *   --actor X  pretend a person converted this from the console instead of
 *              Jetta doing it herself — changes the private note.
 *
 * The transcript, the summary and the visitor are fiction. Everything that
 * happens to them afterwards is production code.
 */

// Before any import: lib/config.ts snapshots env the first time it is loaded.
// Nothing here should be able to reach Slack or write to a monday board even
// by accident, and in the default (captured) mode Freshdesk gets placeholder
// credentials so a missed interception fails loudly instead of posting.
process.env.SLACK_LIVE = "false";
process.env.MONDAY_ALLOW_WRITES = "false";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};

const LIVE = flag("--live");
const KEEP = flag("--keep");
const WITH_FILES = !flag("--no-files");
const ACTOR = opt("--actor");

if (!LIVE) {
  process.env.FRESHDESK_LIVE = "true";
  process.env.FRESHDESK_DOMAIN = "captured.invalid";
  process.env.FRESHDESK_API_KEY = "captured";
}

// Imported inside main(): lib/config.ts reads process.env at import time, and
// the overrides above have to land first. Every script here does this.
type Lib = {
  config: typeof import("../lib/config").config;
  chatTicket: typeof import("../lib/chat-ticket");
  chatStore: typeof import("../lib/chat-store");
  chatFiles: typeof import("../lib/chat-files");
  jettachat: typeof import("../lib/tools/jettachat");
  blob: typeof import("@vercel/blob");
};
let lib: Lib;

type ChatConversation = import("../lib/types").ChatConversation;
type ChatMessage = import("../lib/types").ChatMessage;

// ── The scenario ───────────────────────────────────────────────────
//
// Chosen because it is the shape that actually becomes a ticket: a customer
// who is blocked, a screenshot Jetta can read but can't act on, and an answer
// that needs somebody with account access. Jetta gets one thing right (the
// KB answer about resends) and then runs out of road, which is what makes the
// summary in the ticket worth reading.

const CONV_ID = "scn-chat-ticket-demo";
const VISITOR_EMAIL = "jetta-e2e@jetpackwork.com";
const VISITOR_NAME = "Robin Avery";

const ATTACHMENT_ID = "a1demo";
const ATTACHMENT_NAME = "signing-error.png";
const ATTACHMENT_PATH = `chat/${CONV_ID}/${ATTACHMENT_ID}/${ATTACHMENT_NAME}`;

/**
 * Written the way the upload-time vision pass writes them — transcribed error
 * text first, no speculation about the cause. Stored on the descriptor exactly
 * as `lib/chat-files.ts` would store it, so the transcript line is real.
 */
const VISION_DESCRIPTION =
  'A GetSign signing request page showing a red banner: "This signing link has expired." ' +
  "The document is titled \"Q3 Vendor Agreement.pdf\" and the signer field for r.avery@northwind.example is empty. " +
  "A greyed-out Sign button sits below the banner.";

/** A 1×1 PNG. Real bytes, so the multipart upload is a real multipart upload. */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const t = (minutes: number) => new Date(Date.UTC(2026, 7, 18, 9, minutes, 0)).toISOString();

const messages: ChatMessage[] = [
  {
    id: "m1",
    author: "visitor",
    text: "hi — one of our signers says the link we sent him doesn't work any more. he's the only one left to sign.",
    createdAt: t(2),
  },
  {
    id: "m2",
    author: "agent",
    via: "jetta",
    text: "Happy to help. Signing links expire after the deadline set on the request. You can send a fresh one from the document's page — open the request, find the signer in the list and choose Resend. That issues a new link and invalidates the old one.\n\nCould you send me a screenshot of what he's seeing, so I can confirm that's the same thing?",
    createdAt: t(3),
  },
  {
    id: "m3",
    author: "visitor",
    text: "here's his screen. i tried resend twice already and he gets the same page.",
    attachments: [
      {
        id: ATTACHMENT_ID,
        name: ATTACHMENT_NAME,
        contentType: "image/png",
        size: PNG_BYTES.byteLength,
        pathname: ATTACHMENT_PATH,
        width: 1,
        height: 1,
        description: VISION_DESCRIPTION,
      },
    ],
    createdAt: t(6),
  },
  {
    id: "m4",
    author: "agent",
    via: "jetta",
    text: "Thanks — that's the expiry page, so the resends aren't reaching him with a live link. That usually means the new invitations are being generated against the original deadline rather than a new one, which I can't see or change from here.\n\nCan you tell me the account email you signed in with, and roughly when the request was first sent?",
    createdAt: t(7),
  },
  {
    id: "m5",
    author: "visitor",
    text: "account is ops@northwind.example, request went out on the 11th. we need this signed today — the vendor is waiting on it.",
    createdAt: t(9),
  },
  {
    id: "m6",
    author: "agent",
    via: "jetta",
    text: "Understood, and thank you for the detail. This needs someone who can look at the request itself, so I'm passing it to the team now — what's the best email address for them to reply to?",
    createdAt: t(10),
  },
  {
    id: "m7",
    author: "visitor",
    text: `${VISITOR_EMAIL} — that's me, ops is the shared box.`,
    createdAt: t(11),
  },
];

const conv: ChatConversation = {
  id: CONV_ID,
  createdAt: t(2),
  lastActivityAt: t(11),
  status: "open",
  surface: "wordpress",
  pageUrl: "https://getsign.io/help",
  visitor: {
    name: VISITOR_NAME,
    email: VISITOR_EMAIL,
    app: "getsign",
  },
  messages,
};

/** What Jetta's tool call would carry — her words, not the transcript's. */
const SUMMARY =
  "Customer's final signer gets \"This signing link has expired\" on a Q3 Vendor Agreement, and two resends from the document page produced the same expired page — so the new invitations appear to be inheriting the original deadline rather than getting a fresh one. Account ops@northwind.example, request first sent on the 11th. I confirmed the expiry page from the signer's screenshot and walked through Resend; changing the request's deadline is beyond what I can see. Time-sensitive: the vendor is waiting on the signature today.";

const SUBJECT = "Resent signing link still shows as expired for final signer";

// ── Capture (default) ──────────────────────────────────────────────
//
// Freshdesk's own client code runs untouched; only the socket is replaced. The
// point is to show the payload production would send, not one this script
// rebuilt and got subtly wrong.

interface Captured {
  method: string;
  path: string;
  fields: Record<string, string>;
  files: { name: string; type: string; size: number }[];
  json?: unknown;
}
const captured: Captured[] = [];
const realFetch = globalThis.fetch;

if (!LIVE) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes("captured.invalid")) return realFetch(input as never, init);

    const path = new URL(url).pathname.replace("/api/v2", "");
    const entry: Captured = {
      method: init?.method ?? "GET",
      path,
      fields: {},
      files: [],
    };

    const body = init?.body;
    if (body instanceof FormData) {
      for (const [k, v] of body.entries()) {
        if (typeof v === "string") entry.fields[k] = v;
        else entry.files.push({ name: v.name, type: v.type, size: v.size });
      }
    } else if (typeof body === "string") {
      entry.json = JSON.parse(body);
    }
    captured.push(entry);

    const id = path.endsWith("/notes") ? 990002 : 990001;
    return new Response(JSON.stringify({ id }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

// ── Run it ─────────────────────────────────────────────────────────

const rule = (title: string) => console.log(`\n${"─".repeat(72)}\n${title}\n${"─".repeat(72)}`);

async function main() {
  lib = {
    config: (await import("../lib/config")).config,
    chatTicket: await import("../lib/chat-ticket"),
    chatStore: await import("../lib/chat-store"),
    chatFiles: await import("../lib/chat-files"),
    jettachat: await import("../lib/tools/jettachat"),
    blob: await import("@vercel/blob"),
  };
  const { config, blob } = lib;
  const { openTicketForConversation, suggestedSubject } = lib.chatTicket;
  const { transcriptText } = lib.chatStore;
  const { attachmentLine } = lib.chatFiles;
  const { conversationUrl } = lib.jettachat;

  // The attachment has to exist in blob storage for the hand-off to forward
  // it — collectForHandoff reads bytes, it does not trust the descriptor.
  let uploaded = false;
  if (WITH_FILES && config.blob.token) {
    // allowOverwrite because this script is meant to be run twice. Production
    // never needs it: the pathname carries a per-upload id.
    await blob.put(ATTACHMENT_PATH, PNG_BYTES, {
      access: "private",
      contentType: "image/png",
      addRandomSuffix: false,
      allowOverwrite: true,
      token: config.blob.token,
    });
    uploaded = true;

    // A blob written a millisecond ago is not always readable yet, and a run
    // that raced it produced a ticket with no file and no explanation — which
    // is exactly the failure this script exists to make visible. Wait for the
    // read the hand-off is about to do. Production has minutes of chat between
    // the upload and the ticket, so it never sees this.
    for (let i = 0; i < 6; i++) {
      if (await lib.chatFiles.readFileBytes(ATTACHMENT_PATH).catch(() => null)) break;
      if (i === 5) {
        console.log("! blob write is not readable yet — the ticket will carry no file this run.");
        break;
      }
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  } else if (WITH_FILES) {
    console.log(
      "! BLOB_READ_WRITE_TOKEN is not set, so the screenshot exists only as a transcript line.\n" +
        "  The ticket will show the description but carry no file. Run `vercel env pull` for the full path.",
    );
  }
  if (!WITH_FILES) {
    conv.messages = conv.messages.map((m) => ({ ...m, attachments: undefined }));
  }

  rule("1. THE CHAT, as the visitor and Jetta saw it");
  for (const m of conv.messages) {
    const who = m.author === "visitor" ? VISITOR_NAME : m.via === "human" ? m.authorName : "Jetta";
    console.log(`\n[${m.createdAt.slice(11, 16)}] ${who}:\n  ${m.text.replace(/\n/g, "\n  ")}`);
    for (const a of m.attachments ?? []) console.log(`  ↳ ${a.name} (${a.contentType}, ${a.size} B)`);
  }

  rule("2. WHAT THE HAND-OFF BUILDS");
  console.log(`subject      ${SUBJECT}`);
  console.log(`             (console default would be: "${suggestedSubject(conv)}")`);
  console.log(`requester    ${VISITOR_NAME} <${VISITOR_EMAIL}>`);
  console.log(`productHint  ${conv.visitor.app}  → cf_product`);
  console.log(`source       7 (chat)`);
  console.log(`transcript   ${conv.messages.length} messages, ${transcriptText(conv).length} chars`);
  for (const a of conv.messages.flatMap((m) => m.attachments ?? [])) {
    console.log(`transcript   ${attachmentLine(a).slice(0, 110)}…`);
  }

  rule(LIVE ? "3. POSTING TO FRESHDESK (live)" : "3. WHAT FRESHDESK RECEIVES (captured, not sent)");

  const created = await openTicketForConversation(conv, {
    email: VISITOR_EMAIL,
    subject: SUBJECT,
    summary: SUMMARY,
    productHint: conv.visitor.app,
    ...(ACTOR ? { actor: ACTOR } : {}),
  });

  if (!LIVE) {
    for (const c of captured) {
      console.log(`\n${c.method} ${c.path}`);
      if (c.json) {
        const j = c.json as Record<string, unknown>;
        for (const [k, v] of Object.entries(j)) {
          if (k === "body") continue;
          console.log(`  ${k.padEnd(12)} ${JSON.stringify(v)}`);
        }
        if (typeof j.body === "string") {
          console.log("  body ↓ (rendered back to text)");
          console.log(`    ${fdHtmlToText(j.body).replace(/\n/g, "\n    ")}`);
        }
      }
      for (const [k, v] of Object.entries(c.fields)) {
        if (k === "description") continue;
        console.log(`  ${k.padEnd(12)} ${v}`);
      }
      if (c.fields.description) {
        console.log(`  description ↓ (${c.fields.description.length} chars of HTML, rendered back to text)`);
        console.log(`    ${fdHtmlToText(c.fields.description).replace(/\n/g, "\n    ")}`);
      }
      for (const f of c.files) console.log(`  attachment   ${f.name} (${f.type}, ${f.size} B)`);
    }
  }

  rule("4. THE TICKET");
  console.log(`id   ${created.id}`);
  console.log(`url  ${created.url}`);
  console.log(`chat ${conversationUrl(conv.id)}`);

  console.log(
    "\nCustomer-visible: subject, description (summary + FULL transcript), attachments." +
      "\n  Freshdesk shows the description on the portal and quotes it in the requester's" +
      "\n  notification email — so the customer gets their own chat log back." +
      "\nAgent-only: the private note (back-link, surface, page, who converted it)." +
      "\nSnapshot, not a sync: anything said in the chat AFTER this point never reaches the ticket.",
  );

  if (LIVE) {
    // Same manifest the e2e suite uses, so `scripts/chat-cleanup.ts` can mop
    // this up whether or not the run below gets that far.
    recordForCleanup(created.id);
    if (KEEP) {
      console.log(`\nLeft in Freshdesk for you to look at. Clean up with:\n  npx tsx --env-file=.env.local scripts/chat-cleanup.ts`);
    } else {
      await deleteTicket(created.id);
      console.log("\nDeleted. Pass --keep to leave it in the inbox and open it in Freshdesk.");
    }
  }

  if (uploaded && !KEEP) {
    await blob.del([ATTACHMENT_PATH], { token: config.blob.token }).catch(() => {});
  }
}

/** Freshdesk has no delete in lib/tools — cleanup does it raw, and so does this. */
async function deleteTicket(id: string): Promise<void> {
  const token = Buffer.from(`${lib.config.freshdesk.apiKey}:X`).toString("base64");
  const res = await realFetch(`https://${lib.config.freshdesk.domain}/api/v2/tickets/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Basic ${token}` },
  });
  // 404 counts: the goal is "not there", not "deleted by me".
  if (!res.ok && res.status !== 404) console.warn(`  ticket ${id}: HTTP ${res.status}`);
}

function recordForCleanup(ticketId: string): void {
  const dir = ".chat-eval";
  const file = `${dir}/manifest.json`;
  interface Manifest {
    conversations: string[];
    tickets: string[];
    rateKeys: string[];
    startedAt: string;
  }
  const m: Manifest = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as Manifest)
    : { conversations: [], tickets: [], rateKeys: [], startedAt: new Date().toISOString() };
  if (!m.tickets.includes(ticketId)) m.tickets.push(ticketId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(m, null, 1));
}

/** Freshdesk stores HTML; this puts it back the way an agent reads it. */
function fdHtmlToText(html: string): string {
  return html
    .replace(/<\/p>\s*<p>/g, "\n\n")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<\/?p>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
