/**
 * JettaChat end-to-end: the real routes, over real HTTP, against a running server.
 *
 * Layer 1 (chat-contract-test.ts) proves the functions behave. This proves the
 * HTTP surface does — auth, validation, limits, CORS, the SSE stream, human
 * takeover, and the chat-to-ticket hand-off that was broken from the day it
 * shipped because nobody had ever driven it end to end.
 *
 *   npm run dev
 *   npx tsx --env-file=.env.local scripts/chat-e2e.ts
 *   npx tsx --env-file=.env.local scripts/chat-e2e.ts --base https://preview.vercel.app
 *
 * Flags:
 *   --base <url>   server under test (default http://localhost:3000)
 *   --keep         don't clean up (for inspecting what a run left behind)
 *   --no-agent     skip the one check that spends a real agent run
 *
 * THIS SCRIPT WRITES FOR REAL. It creates conversations, uploads a file, and
 * opens a Freshdesk ticket, then deletes all of it. Everything it creates is
 * recorded in .chat-eval/manifest.json as it goes, so `scripts/chat-cleanup.ts`
 * can finish the job if this run dies halfway. Every artifact carries the test
 * identity below, so anything that escapes is obvious in the inbox.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { Redis } from "@upstash/redis";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};

const BASE = (opt("--base") ?? "http://localhost:3000").replace(/\/$/, "");
const KEEP = flag("--keep");
const NO_AGENT = flag("--no-agent");

/** Obvious in a console inbox, and unmistakable in Freshdesk. */
const TEST_NAME = "Robin Avery";
const TEST_EMAIL = "jetta-e2e@jetpackwork.com";
/** RFC 5737 documentation range — cannot collide with a real visitor's budget. */
const TEST_IP = "203.0.113.7";

const DIR = ".chat-eval";
const MANIFEST = `${DIR}/manifest.json`;

interface Manifest {
  conversations: string[];
  tickets: string[];
  rateKeys: string[];
  startedAt: string;
}
const manifest: Manifest = existsSync(MANIFEST)
  ? JSON.parse(readFileSync(MANIFEST, "utf8"))
  : { conversations: [], tickets: [], rateKeys: [], startedAt: new Date().toISOString() };

function record<K extends "conversations" | "tickets" | "rateKeys">(kind: K, value: string) {
  if (!manifest[kind].includes(value)) manifest[kind].push(value);
  mkdirSync(DIR, { recursive: true });
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));
}

let failures = 0;
let skipped = 0;
function check(name: string, pass: boolean, detail?: string) {
  console.log(`${pass ? "  ok  " : "FAIL  "}${name}${!pass && detail ? ` — ${detail}` : ""}`);
  if (!pass) failures++;
}
function skip(name: string, why: string) {
  console.log(`  --  ${name} — skipped: ${why}`);
  skipped++;
}
const section = (s: string) => console.log(`\n${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body (an error page) — the status is what we assert on */
  }
  return { status: res.status, json, text, headers: res.headers };
}

/** Open a session the way the widget does. */
async function openSession(over: Record<string, unknown> = {}) {
  const r = await post("/api/chat/session", {
    surface: "wordpress",
    pageUrl: "https://jetpackapps.io/e2e",
    visitor: { name: TEST_NAME, email: TEST_EMAIL },
    ...over,
  });
  const id = r.json.conversationId as string | undefined;
  if (id) record("conversations", id);
  return { ...r, id, token: r.json.token as string | undefined };
}

/**
 * Read the SSE stream until `want` is satisfied or the deadline passes.
 * Returns every event seen, so a test can assert on ordering as well as arrival.
 */
async function readStream(
  conversationId: string,
  token: string,
  opts: {
    ms: number;
    /**
     * The last message the client already has. Without it the stream starts at
     * the current end of the transcript and replays nothing — which is correct
     * (a fresh widget got the history from /session) but means a test that
     * opens the stream after the fact sees no events at all.
     */
    after?: string;
    until?: (events: { event: string; data: Record<string, unknown> }[]) => boolean;
  },
) {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.ms);
  try {
    const res = await fetch(
      `${BASE}/api/chat/stream?c=${conversationId}&token=${encodeURIComponent(token)}` +
        (opts.after ? `&after=${encodeURIComponent(opts.after)}` : ""),
      { signal: ctrl.signal },
    );
    if (!res.ok || !res.body) return { events, status: res.status };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() ?? "";
      for (const frame of frames) {
        const event = /^event: (.+)$/m.exec(frame)?.[1];
        const raw = /^data: (.+)$/m.exec(frame)?.[1];
        if (!event || !raw) continue;
        try {
          events.push({ event, data: JSON.parse(raw) });
        } catch {
          /* ignore a partial frame */
        }
      }
      if (opts.until?.(events)) break;
    }
    return { events, status: res.status };
  } catch {
    return { events, status: 0 }; // aborted on the deadline — expected
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

const redis =
  process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
    ? new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN })
    : null;

async function main() {
  console.log(`Target: ${BASE}\nIdentity: ${TEST_NAME} <${TEST_EMAIL}>\n`);

  // ── Is anything even there? ──────────────────────────────────────
  section("Preflight");
  let cfg: Record<string, unknown>;
  try {
    const res = await fetch(`${BASE}/api/chat/config`);
    cfg = (await res.json()) as Record<string, unknown>;
    check("/api/chat/config answers", res.ok, `HTTP ${res.status}`);
  } catch (e) {
    console.error(
      `\nCannot reach ${BASE} — is the dev server running?\n` +
        `  npm run dev\n\n${e instanceof Error ? e.message : e}`,
    );
    process.exit(1);
  }
  if (!cfg.enabled) {
    console.error("The chat channel reports enabled:false — set JETTACHAT_LIVE=true and retry.");
    process.exit(1);
  }
  check("config exposes the greeting", typeof cfg.greeting === "string");
  // The named-subset rule, checked from outside rather than from the function.
  check("config leaks no allowlist", !("allowedOrigins" in cfg));
  check("config leaks no rate limits", !("rateLimitPerHour" in cfg));
  const requireIdentity = cfg.requireIdentity === true;

  // ── Sessions ─────────────────────────────────────────────────────
  section("Session");
  const s = await openSession();
  check("a new session is issued", s.status === 200 && !!s.id && !!s.token, `HTTP ${s.status}`);
  check("a new session starts open", s.json.status === "open", String(s.json.status));

  const resumed = await post("/api/chat/session", { conversationId: s.id, token: s.token });
  check("a session resumes with its token", resumed.status === 200, `HTTP ${resumed.status}`);
  check("resume returns the transcript", Array.isArray(resumed.json.messages));

  const wrongToken = await post("/api/chat/session", { conversationId: s.id, token: "nope" });
  check("resume with a bad token is refused", wrongToken.status === 403, `HTTP ${wrongToken.status}`);

  // A pruned or expired conversation must tell the widget to start over, not
  // 404 it into an error state the visitor cannot clear.
  const ghostId = "00000000-0000-4000-8000-000000000000";
  const ghost = await post("/api/chat/session", {
    conversationId: ghostId,
    // A real token for an id that no longer exists — the expiry path, not the
    // auth path.
    token: await signFor(ghostId),
  });
  check("an expired conversation reports expiry", ghost.status === 410, `HTTP ${ghost.status}`);

  if (requireIdentity) {
    // The widget enforces this too, but the widget is public JavaScript and its
    // form can be skipped by posting straight here.
    const anon = await post("/api/chat/session", { surface: "wordpress", visitor: {} });
    check("identity is enforced server-side", anon.status === 400, `HTTP ${anon.status}`);
    const badEmail = await post("/api/chat/session", {
      surface: "wordpress",
      visitor: { name: TEST_NAME, email: "not-an-email" },
    });
    check("a malformed email is refused", badEmail.status === 400, `HTTP ${badEmail.status}`);
  } else {
    skip("identity enforcement", "requireIdentity is off in the live settings");
  }

  // ── Message validation ───────────────────────────────────────────
  section("Message validation");
  const empty = await post("/api/chat/message", { conversationId: s.id, token: s.token, text: "  " });
  check("an empty message is refused", empty.status === 400, `HTTP ${empty.status}`);

  const long = await post("/api/chat/message", {
    conversationId: s.id,
    token: s.token,
    text: "x".repeat(4001),
  });
  check("an over-long message is refused", long.status === 413, `HTTP ${long.status}`);

  const forged = await post("/api/chat/message", {
    conversationId: s.id,
    token: "forged",
    text: "hello",
  });
  check("a forged token cannot post", forged.status === 403, `HTTP ${forged.status}`);

  // ── CORS ─────────────────────────────────────────────────────────
  //
  // The browser is what enforces this, so the assertion is on the headers: an
  // unlisted origin must get none at all.
  section("CORS");
  const evil = await fetch(`${BASE}/api/chat/config`, { headers: { origin: "https://evil.example" } });
  check(
    "an unlisted origin gets no CORS header",
    !evil.headers.get("access-control-allow-origin"),
    String(evil.headers.get("access-control-allow-origin")),
  );
  const allowedOrigin = await firstAllowedOrigin();
  if (allowedOrigin) {
    const ok = await fetch(`${BASE}/api/chat/config`, { headers: { origin: allowedOrigin } });
    check(
      `a configured origin is allowed (${allowedOrigin})`,
      ok.headers.get("access-control-allow-origin") === allowedOrigin,
      String(ok.headers.get("access-control-allow-origin")),
    );
    const pre = await fetch(`${BASE}/api/chat/session`, {
      method: "OPTIONS",
      headers: { origin: allowedOrigin, "access-control-request-method": "POST" },
    });
    check("preflight answers 204", pre.status === 204, `HTTP ${pre.status}`);
  } else {
    skip("positive CORS check", "no origins configured to test against");
  }

  // ── Rate limits ──────────────────────────────────────────────────
  //
  // Seeded rather than reached: reaching the message limit honestly would cost
  // sixty agent runs. The counter is seeded for a documentation-range IP, so no
  // real visitor's budget is touched, and the key is deleted afterwards.
  section("Rate limits");
  if (!redis) {
    skip("rate limits", "no KV credentials — run with --env-file=.env.local");
  } else {
    const msgKey = `jetta:chat:rate:${TEST_IP}`;
    const upKey = `jetta:chat:uploadrate:${TEST_IP}`;
    await redis.set(msgKey, 100_000, { ex: 3600 });
    record("rateKeys", msgKey);
    const limited = await post(
      "/api/chat/message",
      { conversationId: s.id, token: s.token, text: "hello?" },
      { "x-forwarded-for": TEST_IP },
    );
    check("an over-budget IP is rate limited", limited.status === 429, `HTTP ${limited.status}`);

    // The upload budget is separate and far smaller — sharing the message
    // allowance is what let one IP buy sixty vision calls an hour.
    await redis.del(msgKey);
    await redis.set(upKey, 100_000, { ex: 3600 });
    record("rateKeys", upKey);
    const form = new FormData();
    form.set("conversationId", s.id!);
    form.set("token", s.token!);
    form.set("file", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }), "x.png");
    const upLimited = await fetch(`${BASE}/api/chat/upload`, {
      method: "POST",
      headers: { "x-forwarded-for": TEST_IP },
      body: form,
    });
    check("the upload budget is enforced separately", upLimited.status === 429, `HTTP ${upLimited.status}`);
    // …and messages still flow for that IP, proving the two budgets are distinct.
    const stillOk = await post(
      "/api/chat/message",
      { conversationId: s.id, token: s.token, text: "" },
      { "x-forwarded-for": TEST_IP },
    );
    check(
      "an exhausted upload budget does not block messages",
      stillOk.status === 400,
      `expected the empty-message 400, got ${stillOk.status}`,
    );
    await redis.del(upKey);
  }

  // ── File serving ─────────────────────────────────────────────────
  section("Attachment serving");
  const other = await openSession();
  const crossToken = other.token!;
  const stolen = await fetch(
    `${BASE}/api/chat/file/${s.id}/someid/shot.png?token=${encodeURIComponent(crossToken)}`,
  );
  check(
    "another conversation's token cannot read these files",
    stolen.status === 403,
    `HTTP ${stolen.status}`,
  );
  const noToken = await fetch(`${BASE}/api/chat/file/${s.id}/someid/shot.png`);
  check("no token at all is refused", noToken.status === 403, `HTTP ${noToken.status}`);

  // ── The stream, and one real answer ──────────────────────────────
  section("Stream and reply");
  if (NO_AGENT) {
    skip("live agent turn", "--no-agent");
  } else {
    const conv = await openSession();
    const question = "How do I set up a VLOOKUP recipe between two boards?";
    // Start listening BEFORE sending, the way the widget does — a reply that
    // lands between the POST and the stream opening is the bug this ordering
    // catches.
    const listening = readStream(conv.id!, conv.token!, {
      ms: 180_000,
      until: (evts) =>
        evts.some((e) => e.event === "message" && (e.data as { author?: string }).author === "agent"),
    });
    await sleep(500);
    const sent = await post("/api/chat/message", {
      conversationId: conv.id,
      token: conv.token,
      text: question,
    });
    check("the message is accepted", sent.status === 200, `HTTP ${sent.status}`);

    const { events } = await listening;
    const agentMsgs = events.filter(
      (e) => e.event === "message" && (e.data as { author?: string }).author === "agent",
    );
    check("Jetta replies over the stream", agentMsgs.length > 0, `${events.length} events, no agent message`);
    check(
      "the visitor's own message is echoed on the stream",
      events.some((e) => e.event === "message" && (e.data as { text?: string }).text === question),
    );
    // A typing indicator that never clears is the widget's most visible bug.
    const typing = events.filter((e) => e.event === "typing");
    check("a typing indicator is sent", typing.length > 0, `${typing.length} typing events`);
    check(
      "the typing indicator clears",
      typing.at(-1)?.data.typing === false || agentMsgs.length > 0,
      JSON.stringify(typing.map((t) => t.data.typing)),
    );
    const reply = String((agentMsgs[0]?.data as { text?: string })?.text ?? "");
    check("the reply is not empty", reply.trim().length > 0);
    // The fallback is what a crashed run sends. Seeing it here means the agent
    // loop failed rather than answered.
    check(
      "the reply is a real answer, not the failure fallback",
      !/something went wrong on my end/i.test(reply),
      reply.slice(0, 120),
    );

    // Replay-from-cursor: a widget whose connection dropped mid-answer must be
    // handed everything it missed, not a transcript with a hole in it.
    const firstId = String((events.find((e) => e.event === "message")?.data as { id?: string })?.id ?? "");
    const replay = await readStream(conv.id!, conv.token!, {
      ms: 8000,
      after: firstId,
      until: (evts) => evts.some((e) => e.event === "message"),
    });
    check(
      "reconnecting replays what was missed",
      replay.events.some((e) => e.event === "message"),
      `${replay.events.length} events after cursor ${firstId.slice(0, 8)}`,
    );
    // An unknown cursor (client state older than the retention window) must
    // replay the whole transcript rather than silently showing a gap.
    const fullReplay = await readStream(conv.id!, conv.token!, {
      ms: 8000,
      after: "a-cursor-that-no-longer-exists",
      until: (evts) => evts.filter((e) => e.event === "message").length >= 2,
    });
    check(
      "an unknown cursor replays the whole transcript",
      fullReplay.events.filter((e) => e.event === "message").length >= 2,
      `${fullReplay.events.filter((e) => e.event === "message").length} messages`,
    );
  }

  const badStream = await fetch(`${BASE}/api/chat/stream?c=${s.id}&token=wrong`);
  check("the stream refuses a bad token", badStream.status === 403, `HTTP ${badStream.status}`);

  // ── Human takeover ───────────────────────────────────────────────
  section("Human takeover");
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    skip("takeover and ticket conversion", "ADMIN_SECRET is not set");
  } else {
    const admin = { "x-admin-secret": adminSecret };
    const conv = await openSession();
    await post("/api/chat/message", { conversationId: conv.id, token: conv.token, text: "is anyone there?" });

    const unauth = await post("/api/admin/chats", { conversationId: conv.id, action: "join" });
    check("the admin route refuses an unauthenticated caller", unauth.status === 401, `HTTP ${unauth.status}`);

    const joined = await post("/api/admin/chats", { conversationId: conv.id, action: "join" }, admin);
    check("a colleague can join", joined.status === 200 && joined.json.status === "human", joined.text);

    // The visitor's own stream is how they see it, so that is where it is
    // checked — and it is opened BEFORE the colleague types, because that is
    // the real sequence: the widget is already sitting there listening.
    const seenPromise = readStream(conv.id!, conv.token!, {
      ms: 15_000,
      until: (evts) =>
        evts.some((e) => e.event === "message" && /Suraj here/.test(String((e.data as { text?: string }).text))),
    });
    await sleep(500);

    const said = await post(
      "/api/admin/chats",
      { conversationId: conv.id, action: "send", text: "Hi, Suraj here — taking a look." },
      admin,
    );
    check("a colleague can send", said.status === 200, said.text);
    const seen = await seenPromise;
    check(
      "the visitor receives the colleague's message",
      seen.events.some((e) => /Suraj here/.test(String((e.data as { text?: string }).text ?? ""))),
      `${seen.events.length} events`,
    );
    check(
      "the message is attributed to a person, not to Jetta",
      seen.events.some((e) => (e.data as { via?: string }).via === "human"),
    );

    const released = await post("/api/admin/chats", { conversationId: conv.id, action: "release" }, admin);
    check("the conversation can be handed back", released.status === 200, released.text);
    const after = await post("/api/chat/session", { conversationId: conv.id, token: conv.token });
    check("status returns to open", after.json.status === "open", String(after.json.status));

    // ── Ticket conversion ──────────────────────────────────────────
    //
    // The path that was broken from the day it shipped: Freshdesk rejected
    // every one of these for a missing product_id and the failure was swallowed.
    section("Chat to ticket");
    const noEmail = await openSession({ visitor: { name: TEST_NAME, email: "" } });
    if (noEmail.status === 400) {
      skip("no-email guard", "identity is mandatory, so this state is unreachable from the widget");
    } else {
      const refused = await post(
        "/api/admin/chats",
        { conversationId: noEmail.id, action: "ticket" },
        admin,
      );
      check("a ticket is refused with no requester", refused.status === 400, `HTTP ${refused.status}`);
    }

    const toTicket = await openSession();
    await post("/api/chat/message", {
      conversationId: toTicket.id,
      token: toTicket.token,
      text: "E2E test — please ignore. Converting this chat to a ticket.",
    });
    const ticketed = await post(
      "/api/admin/chats",
      {
        conversationId: toTicket.id,
        action: "ticket",
        subject: "[E2E] chat-to-ticket check — safe to delete",
        text: "Opened by scripts/chat-e2e.ts. Deleted automatically.",
      },
      admin,
    );
    const ticketId = String(ticketed.json.ticketId ?? "");
    if (ticketId) record("tickets", ticketId);
    check("the chat converts to a ticket", ticketed.status === 200 && !!ticketId, ticketed.text.slice(0, 200));

    if (ticketId) {
      const conv2 = await post("/api/chat/session", { conversationId: toTicket.id, token: toTicket.token });
      check("the conversation is marked ticketed", conv2.json.status === "ticketed", String(conv2.json.status));
      check(
        "the visitor is told it became a ticket",
        (conv2.json.messages as { text: string }[]).some((m) => /ticket/i.test(m.text)),
      );
      // A second press must not open a second thread.
      const again = await post(
        "/api/admin/chats",
        { conversationId: toTicket.id, action: "ticket" },
        admin,
      );
      check("converting twice reuses the first ticket", again.json.alreadyTicketed === true, again.text.slice(0, 160));

      // …and a ticketed conversation stops the bot rather than restarting it.
      const afterTicket = await post("/api/chat/message", {
        conversationId: toTicket.id,
        token: toTicket.token,
        text: "one more thing",
      });
      check(
        "a ticketed conversation accepts the message but does not wake Jetta",
        afterTicket.json.ticketed === true,
        afterTicket.text.slice(0, 160),
      );

      await verifyTicket(ticketId);
    }
  }

  // ── Cleanup ──────────────────────────────────────────────────────
  section("Cleanup");
  if (KEEP) {
    console.log(`  --  kept ${manifest.conversations.length} conversations and ${manifest.tickets.length} tickets (--keep)`);
  } else {
    await cleanup();
  }

  console.log(
    `\n${failures ? "FAILED" : "PASSED"} — ${failures} failure${failures === 1 ? "" : "s"}` +
      (skipped ? `, ${skipped} skipped` : ""),
  );
  process.exit(failures ? 1 : 0);
}

/** Sign a conversation id the way the server does, to test the expiry path. */
async function signFor(id: string): Promise<string> {
  const crypto = await import("node:crypto");
  const secret = process.env.JETTACHAT_SECRET;
  if (!secret) return "unsigned";
  return crypto.createHmac("sha256", secret).update(id).digest("base64url");
}

/** An origin the live settings actually allow, read without modifying anything. */
async function firstAllowedOrigin(): Promise<string | null> {
  if (!redis) return null;
  const stored = await redis.get<{ allowedOrigins?: string[] }>("jetta:chat:settings");
  const fromEnv = (process.env.JETTACHAT_ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim());
  const all = [...(stored?.allowedOrigins ?? []), ...fromEnv].filter(Boolean);
  // A wildcard entry cannot be sent as an Origin header, so pick a literal one.
  return all.find((o) => !o.includes("*")) ?? null;
}

/** Read the ticket back from Freshdesk — the note is private, and the fields are right. */
async function verifyTicket(ticketId: string) {
  const domain = process.env.FRESHDESK_DOMAIN ?? "jetpackwork.freshdesk.com";
  const key = process.env.FRESHDESK_API_KEY;
  if (!key) return skip("ticket verification", "no Freshdesk API key");
  const auth = "Basic " + Buffer.from(`${key}:X`).toString("base64");
  const res = await fetch(`https://${domain}/api/v2/tickets/${ticketId}?include=conversations`, {
    headers: { Authorization: auth },
  });
  if (!res.ok) return check("the ticket exists in Freshdesk", false, `HTTP ${res.status}`);
  const t = (await res.json()) as {
    subject: string;
    description_text: string;
    conversations?: { private: boolean; body_text: string }[];
  };
  check("the ticket exists in Freshdesk", true);
  check("the subject carries through", /E2E/.test(t.subject), t.subject);
  // The console link goes in a PRIVATE note: Freshdesk shows the description to
  // the requester in the portal and quotes it in the notification email.
  const notes = t.conversations?.filter((c) => c.private) ?? [];
  check("a private note was attached", notes.length > 0, `${t.conversations?.length ?? 0} conversations`);
  // The note must always identify the conversation. Whether it does so as a
  // clickable link depends on JETTA_APP_URL, which is absent locally and
  // supplied by Vercel everywhere else — so the link form is asserted only
  // where it can hold, rather than failing every local run for an env var.
  check(
    "the note points back at the conversation",
    notes.some((n) => /\/chats\/|jettachat conversation/.test(n.body_text)),
    notes.map((n) => n.body_text.slice(0, 80)).join(" | "),
  );
  const appUrl = process.env.JETTA_APP_URL ?? process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (appUrl) {
    check(
      "the note carries a clickable console link",
      notes.some((n) => /\/chats\//.test(n.body_text)),
      notes.map((n) => n.body_text.slice(0, 80)).join(" | "),
    );
  } else {
    skip("clickable console link", "JETTA_APP_URL is unset locally — the note falls back to the bare id");
  }
  check(
    "internal links stay out of the customer-visible description",
    !/\/chats\//.test(t.description_text ?? ""),
    (t.description_text ?? "").slice(0, 120),
  );
}

/** Reverse everything this run created. Idempotent. */
async function cleanup() {
  const domain = process.env.FRESHDESK_DOMAIN ?? "jetpackwork.freshdesk.com";
  const key = process.env.FRESHDESK_API_KEY;

  let tickets = 0;
  for (const id of manifest.tickets) {
    if (!key) break;
    const auth = "Basic " + Buffer.from(`${key}:X`).toString("base64");
    const res = await fetch(`https://${domain}/api/v2/tickets/${id}`, {
      method: "DELETE",
      headers: { Authorization: auth },
    });
    if (res.ok || res.status === 404) tickets++;
    else check(`ticket ${id} deleted`, false, `HTTP ${res.status}`);
  }
  check(
    `${tickets}/${manifest.tickets.length} test tickets deleted`,
    tickets === manifest.tickets.length,
  );

  let convs = 0;
  if (redis) {
    for (const id of manifest.conversations) {
      await redis.del(`jetta:chat:${id}`);
      await redis.zrem("jetta:chats", id);
      convs++;
    }
    for (const k of manifest.rateKeys) await redis.del(k);
  }
  check(
    `${convs}/${manifest.conversations.length} test conversations removed`,
    !redis || convs === manifest.conversations.length,
  );

  // Verified from the outside: gone from the store means gone from the inbox.
  if (redis && manifest.conversations.length) {
    const survivors = [];
    for (const id of manifest.conversations) {
      if (await redis.exists(`jetta:chat:${id}`)) survivors.push(id);
    }
    check("nothing is left in the console inbox", survivors.length === 0, survivors.join(", "));
  }

  writeFileSync(
    MANIFEST,
    JSON.stringify({ conversations: [], tickets: [], rateKeys: [], startedAt: manifest.startedAt }, null, 1),
  );
}

main().catch(async (e) => {
  console.error("ERROR:", e instanceof Error ? e.stack : e);
  console.error(`\nArtifacts are recorded in ${MANIFEST} — run scripts/chat-cleanup.ts to remove them.`);
  process.exit(1);
});
