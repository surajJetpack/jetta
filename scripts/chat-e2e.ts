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
 *   npx tsx --env-file=.env.local scripts/chat-e2e.ts \
 *     --base https://jettajetpack.vercel.app --origin https://staging.getsign.io
 *
 * Flags:
 *   --base <url>   server under test (default http://localhost:3000)
 *   --origin <url> embed the widget from this origin — sent as the Origin
 *                  header on every call, and used for pageUrl. This is what
 *                  selects a brand profile, so it is how a GetSign run differs
 *                  from a portfolio one.
 *   --product <k>  force a brand profile via ?product=, the way a monday app
 *                  view does. Independent of --origin; either selects a brand.
 *   --surface <s>  wordpress (default) or monday. A monday run drives the
 *                  session the install snippet builds inside an app view, and
 *                  adds the checks that can only fail there.
 *   --slug <s>     monday account slug for a monday run (default: the GetSign
 *                  test account).
 *   --keep         don't clean up (for inspecting what a run left behind)
 *   --no-agent     skip the one check that spends a real agent run
 *
 * BRAND. Without --origin/--product this drives the MAIN profile, which is
 * what it did for its whole life — every assertion it made was a portfolio
 * assertion, including the CORS one, which picked whatever origin happened to
 * be listed first. A brand run additionally proves the things that can only be
 * wrong per-brand: the skin the widget is served, the `app` pinned onto the
 * visitor (which is what makes cf_product attribution work), the KB scope the
 * live index actually enforces, and the product label on the ticket.
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
/** The page the widget is embedded on. Absent = no Origin header at all. */
const ORIGIN = opt("--origin")?.replace(/\/$/, "");
/** An explicit ?product=, as the monday install snippet sets it. */
const PRODUCT = opt("--product");
/**
 * Which surface the run pretends to be. Everything in this script was a
 * WordPress run for its whole life, so the monday path — the one the install
 * snippet builds, and the one that carries the account slug the trial and
 * discount tools would otherwise have to ask the customer for — had never been
 * driven end to end at all.
 */
const SURFACE = opt("--surface") ?? "wordpress";
/**
 * The monday account the visitor belongs to. Real by default: a made-up slug
 * proves the field is stored but not that it is the shape the monetization
 * tools accept. `mallasrj01s-team` is the test account GetSign is installed on.
 */
const SLUG = opt("--slug") ?? (SURFACE === "monday" ? "mallasrj01s-team" : undefined);
/** The identity the monday SDK hands over, as `monday.api()` returns it. */
const MONDAY_VISITOR = SURFACE === "monday" ? { mondayAccountSlug: SLUG, mondayAccountId: "12345678", mondayUserId: "87654321" } : {};
/**
 * Which brand this run is asserting against.
 *
 * Mirrors `profileForRequest` deliberately loosely: the script must not import
 * the code it is testing, or a profile resolution bug would agree with itself
 * and pass. An explicit product wins, then a getsign.io origin (apex or any
 * subdomain — staging.getsign.io is where the widget actually lives).
 */
const BRAND: "getsign" | "main" =
  PRODUCT === "getsign" || (!PRODUCT && /^https:\/\/([^/]+\.)?getsign\.io$/i.test(ORIGIN ?? ""))
    ? "getsign"
    : "main";
/** Brand mode only asserts when the caller actually asked for a brand. */
const BRANDED = !!ORIGIN || !!PRODUCT;

/** ?product= on the two public routes that resolve a profile. */
const q = PRODUCT ? `?product=${encodeURIComponent(PRODUCT)}` : "";
/** The Origin header, when the run is embedded somewhere. */
const originHeaders: Record<string, string> = ORIGIN ? { origin: ORIGIN } : {};

/** Obvious in a console inbox, and unmistakable in Freshdesk. */
const TEST_NAME = "Robin Avery";
const TEST_EMAIL = "jetta-e2e@jetpackwork.com";
/** RFC 5737 documentation range — cannot collide with a real visitor's budget. */
const TEST_IP = "203.0.113.7";

const DIR = ".chat-eval";
const MANIFEST = `${DIR}/manifest.json`;

/**
 * A real 1×1 PNG.
 *
 * Not four magic bytes: the upload route sniffs the actual content so a .txt
 * renamed to .png is refused, and a truncated stub is refused by the same
 * rule. Sending one made the upload-budget check fail with a 415 that read
 * like a rate-limiting bug and was in fact the file validator working.
 */
const PNG_BYTES = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

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
    // Origin first, so a caller that deliberately overrides it still can —
    // the CORS section sends an unlisted one on purpose.
    headers: { "content-type": "application/json", ...originHeaders, ...headers },
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

/** Open a session the way the widget does — from the origin under test. */
async function openSession(over: Record<string, unknown> = {}) {
  const r = await post(`/api/chat/session${q}`, {
    surface: SURFACE,
    // The page has to sit on the origin, not on a hardcoded portfolio URL: it
    // is what the agent and the ticket's private note report as the surface,
    // and a GetSign run that says jetpackapps.io there is telling the ticket a
    // lie the transcript cannot correct.
    pageUrl: `${ORIGIN ?? "https://jetpackapps.io"}/e2e`,
    visitor: { name: TEST_NAME, email: TEST_EMAIL, ...MONDAY_VISITOR },
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
  console.log(
    `Target: ${BASE}\nIdentity: ${TEST_NAME} <${TEST_EMAIL}>\n` +
      (BRANDED
        ? `Brand:  ${BRAND}${ORIGIN ? ` — embedded from ${ORIGIN}` : ""}${PRODUCT ? ` — ?product=${PRODUCT}` : ""}\n`
        : "Brand:  main (no --origin/--product)\n"),
  );

  // ── Is anything even there? ──────────────────────────────────────
  section("Preflight");
  let cfg: Record<string, unknown>;
  try {
    const res = await fetch(`${BASE}/api/chat/config${q}`, { headers: originHeaders });
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

  // ── Brand profile ────────────────────────────────────────────────
  //
  // Only meaningful when a brand was asked for. The bug this exists to catch
  // is not "the overlay is wrong" — it is the two surfaces DISAGREEING about
  // which brand this is, which is invisible until a setting depends on it and
  // then presents as the widget hiding the identity form and the server
  // refusing the session for not filling it in.
  section("Brand profile");
  if (!BRANDED) {
    skip("brand profile", "no --origin/--product — this is a main-profile run");
  } else {
    // The unbranded config is the control. Comparing against a hardcoded
    // expectation would just re-encode the console's current settings here and
    // fail every time someone edits them.
    const baseCfg = (await (await fetch(`${BASE}/api/chat/config`)).json()) as Record<string, unknown>;
    const differs =
      baseCfg.subtitle !== cfg.subtitle ||
      baseCfg.accentColor !== cfg.accentColor ||
      baseCfg.title !== cfg.title;
    if (BRAND === "getsign") {
      check(
        "the GetSign surface is served a different skin from the portfolio one",
        differs,
        `subtitle ${JSON.stringify(cfg.subtitle)} / accent ${JSON.stringify(cfg.accentColor)} — same as base`,
      );
      check(
        "the skin actually names GetSign",
        /getsign/i.test(`${cfg.title ?? ""} ${cfg.subtitle ?? ""}`),
        `title ${JSON.stringify(cfg.title)}, subtitle ${JSON.stringify(cfg.subtitle)}`,
      );
    } else {
      check("a non-brand origin keeps the base skin", !differs);
    }

    // Retrieval scope, read from the index the deployment actually queries.
    //
    // A layer below the HTTP surface, and deliberately so: this is the one
    // fact about a brand run that cannot be observed from outside without
    // spending an agent turn and then guessing at prose. The offline profile
    // test pins the same rule against a stub corpus; this asserts the LIVE
    // index carries the metadata that makes the rule enforceable at all.
    await checkLiveKbScope();
  }

  // ── Sessions ─────────────────────────────────────────────────────
  section("Session");
  const s = await openSession();
  check("a new session is issued", s.status === 200 && !!s.id && !!s.token, `HTTP ${s.status}`);
  check("a new session starts open", s.json.status === "open", String(s.json.status));

  /**
   * Whether the KV this script can reach is the one the TARGET writes to.
   *
   * `.env.local` and a deployment need not share a Redis — and against prod
   * they don't. Without this the store-level checks below read an empty
   * database and report the conversation as having no surface, no slug and no
   * brand pin: four failures describing the script's credentials rather than
   * the product, on a run whose HTTP half is entirely green. The session was
   * just issued, so the record exists by definition; not finding it means we
   * are looking somewhere else.
   */
  const sameStore = !!redis && !!s.id && !!(await redis.get(`jetta:chat:${s.id}`));
  const OTHER_STORE = `the KV in the environment file is not the one ${BASE} writes to`;

  // The pin the whole brand hangs on. `visitor.app` is not in the session
  // response — it is internal — so it is read from the store, which is also
  // where it has to be right: conversationToTicket turns it into productHint,
  // buildContext treats that as ground truth, and everything downstream
  // (KB scope, the prompt's brand, cf_product on the ticket) follows from it.
  if (BRANDED && sameStore) {
    const stored = await redis.get<{ visitor?: { app?: string } }>(`jetta:chat:${s.id}`);
    const app = stored?.visitor?.app;
    check(
      BRAND === "getsign"
        ? "the visitor is pinned to getsign at session creation"
        : "no brand is pinned for a portfolio visitor",
      BRAND === "getsign" ? app === "getsign" : !app,
      `visitor.app = ${JSON.stringify(app)}`,
    );
  } else if (BRANDED) {
    skip(
      "visitor brand pin",
      redis ? OTHER_STORE : "no KV credentials — run with --env-file=.env.local",
    );
  }

  const resumed = await post("/api/chat/session", { conversationId: s.id, token: s.token });
  check("a session resumes with its token", resumed.status === 200, `HTTP ${resumed.status}`);
  check("resume returns the transcript", Array.isArray(resumed.json.messages));

  const wrongToken = await post("/api/chat/session", { conversationId: s.id, token: "nope" });
  check("resume with a bad token is refused", wrongToken.status === 403, `HTTP ${wrongToken.status}`);

  // A pruned or expired conversation must tell the widget to start over, not
  // 404 it into an error state the visitor cannot clear.
  //
  // This is the one check that needs the TARGET's signing secret rather than a
  // token the target handed us: the point is a VALID token for an id that no
  // longer exists. Against a deployment whose JETTACHAT_SECRET differs from
  // the local one the request is rejected at auth and never reaches the expiry
  // branch — a 403 that reads like a broken expiry path and is nothing of the
  // sort. Compare a locally-signed token for a REAL conversation against the
  // one the server just issued for it, and only assert when they agree.
  const secretMatches = s.id ? (await signFor(s.id)) === s.token : false;
  if (!secretMatches) {
    skip(
      "expired-conversation handling",
      `the local JETTACHAT_SECRET does not match ${BASE} — a forged-looking token cannot reach the expiry path`,
    );
  } else {
    const ghostId = "00000000-0000-4000-8000-000000000000";
    const ghost = await post("/api/chat/session", {
      conversationId: ghostId,
      token: await signFor(ghostId),
    });
    check("an expired conversation reports expiry", ghost.status === 410, `HTTP ${ghost.status}`);
  }

  // ── The monday app view ──────────────────────────────────────────
  //
  // Everything a monday run has that a WordPress one doesn't comes down to
  // three fields the install snippet reads out of the SDK. They are not in the
  // session response — they exist to be read by the agent's context, where
  // `mondayAccountSlug` becomes the line that tells Jetta to use the account
  // she was handed rather than asking the customer for their monday URL. So
  // the store is where they have to be right.
  section("monday app view");
  if (SURFACE !== "monday") {
    skip("monday app view", "not a monday run — pass --surface monday");
  } else if (!sameStore) {
    // The store half can't run, but the refusal below is pure HTTP and is the
    // check most worth keeping — it is the one guarding the snippet.
    skip(
      "monday visitor fields",
      redis ? OTHER_STORE : "no KV credentials — run with --env-file=.env.local",
    );
    await checkContextOnlyRefused();
  } else {
    const stored = await redis!.get<{
      surface?: string;
      visitor?: { name?: string; mondayAccountSlug?: string; mondayAccountId?: string; mondayUserId?: string };
    }>(`jetta:chat:${s.id}`);
    check("the conversation records the monday surface", stored?.surface === "monday", `surface = ${JSON.stringify(stored?.surface)}`);
    check(
      "the account slug survives into the store",
      stored?.visitor?.mondayAccountSlug === SLUG,
      `mondayAccountSlug = ${JSON.stringify(stored?.visitor?.mondayAccountSlug)}`,
    );
    check(
      "the monday account and user ids are kept too",
      !!stored?.visitor?.mondayAccountId && !!stored?.visitor?.mondayUserId,
      `account ${JSON.stringify(stored?.visitor?.mondayAccountId)}, user ${JSON.stringify(stored?.visitor?.mondayUserId)}`,
    );

    await checkContextOnlyRefused();
  }

  /**
   * The snippet bug, pinned from the outside.
   *
   * `monday.get("context")` returns ids only — no name, no email, no account
   * slug. A snippet that reads identity from there sends exactly this, and the
   * visitor is then shown the identity form the snippet exists to skip.
   * Asserting the refusal is what makes that a loud failure rather than a quiet
   * regression in a file nobody re-reads.
   */
  async function checkContextOnlyRefused() {
    if (!requireIdentity) {
      skip("context-only monday session", "requireIdentity is off in the live settings");
      return;
    }
    const ctxOnly = await post(`/api/chat/session${q}`, {
      surface: "monday",
      visitor: { mondayAccountId: MONDAY_VISITOR.mondayAccountId, mondayUserId: MONDAY_VISITOR.mondayUserId },
    });
    check(
      "a monday session with ids but no identity is refused",
      ctxOnly.status === 400,
      `HTTP ${ctxOnly.status} — the context object alone must not be enough`,
    );
  }

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
  // The origin under test, when there is one. Falling back to "whatever is
  // listed first" is how a GetSign run used to certify staging.jetpackapps.io.
  const allowedOrigin = ORIGIN ?? (await firstAllowedOrigin());
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

    // Can this target even be told which IP it is talking to?
    //
    // The technique here is to seed a documentation-range IP's counter and
    // then claim that IP. Vercel OVERWRITES a client-supplied x-forwarded-for
    // with the real client address, so behind a real edge the seeded counter
    // is never read and the request is correctly allowed — which is the
    // limiter working and spoofing failing, not a defect. Detected rather
    // than assumed: if the seeded key did not move, nothing read it.
    const seenSeed = Number(await redis.get(msgKey)) !== 100_000 || limited.status === 429;
    if (!seenSeed) {
      skip(
        "rate limits",
        `${BASE} rewrites x-forwarded-for (spoofing is refused, which is correct) — ` +
          "these checks only mean anything against a local dev server",
      );
      await redis.del(msgKey);
    } else {
      check("an over-budget IP is rate limited", limited.status === 429, `HTTP ${limited.status}`);

    // The upload budget is separate and far smaller — sharing the message
    // allowance is what let one IP buy sixty vision calls an hour.
      await redis.del(msgKey);
      await redis.set(upKey, 100_000, { ex: 3600 });
      record("rateKeys", upKey);
      const form = new FormData();
      form.set("conversationId", s.id!);
      form.set("token", s.token!);
      form.set("file", new Blob([PNG_BYTES], { type: "image/png" }), "x.png");
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

  // Content is sniffed, not trusted: the declared type and the extension both
  // say PNG here and the bytes do not. Refused BEFORE the vision call, which
  // is the half that costs money — so this is also the cheapest check in the
  // file, and it stays cheap only as long as it keeps failing validation.
  const fake = new FormData();
  fake.set("conversationId", s.id!);
  fake.set("token", s.token!);
  fake.set("file", new Blob([new TextEncoder().encode("not a png, just text")], { type: "image/png" }), "x.png");
  const fakeRes = await fetch(`${BASE}/api/chat/upload`, { method: "POST", body: fake });
  check(
    "a file whose bytes are not what it claims is refused",
    fakeRes.status === 415,
    `HTTP ${fakeRes.status}`,
  );

  // ── The stream, and one real answer ──────────────────────────────
  section("Stream and reply");
  if (NO_AGENT) {
    skip("live agent turn", "--no-agent");
  } else {
    const conv = await openSession();
    // Ask the brand what the brand is for. On a GetSign run the portfolio
    // question is the WRONG probe: under KB scope she is supposed to decline
    // it, so "the reply is a real answer" would be asserting the opposite of
    // the intended behaviour. The cross-brand probe is a separate turn below.
    const question =
      BRAND === "getsign"
        ? "How do I send a document out for signature?"
        : "How do I set up a VLOOKUP recipe between two boards?";
    // Start listening BEFORE sending, the way the widget does — a reply that
    // lands between the POST and the stream opening is the bug this ordering
    // catches.
    const listening = readStream(conv.id!, conv.token!, {
      ms: 180_000,
      // Keep listening past the reply until the indicator clears. It clears a
      // second or two AFTER the message lands, so stopping on the message
      // alone made "the typing indicator clears" unobservable — which is why
      // that check used to carry an escape hatch that made it unfailable.
      until: (evts) => {
        const replied = evts.some(
          (e) => e.event === "message" && (e.data as { author?: string }).author === "agent",
        );
        const cleared =
          evts.filter((e) => e.event === "typing").at(-1)?.data.typing === false;
        return replied && cleared;
      },
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
    // Specifically that it turns ON. The old assertion was `typing.length > 0`,
    // which the stream satisfies with the single `typing:false` it sends on
    // connect — so it passed for months while the indicator never once lit up.
    check(
      "the typing indicator turns on",
      typing.some((t) => t.data.typing === true),
      JSON.stringify(typing.map((t) => t.data.typing)),
    );
    check(
      "the typing indicator clears",
      // No `|| agentMsgs.length` escape hatch: a reply arriving is not evidence
      // the indicator cleared, and that clause made this unfailable too.
      typing.at(-1)?.data.typing === false,
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

/**
 * Does the live index actually enforce the brand's KB scope?
 *
 * `JETTA_KB_SCOPE` is only half the switch. The other half is metadata on the
 * vectors, and the two were shipped apart: the filter syntax was accepted by
 * Upstash months before any vector carried a `product`, so a scoped query
 * returned zero hits and the GetSign bot would have answered nothing at all.
 * That failure is silent from every other vantage point in this suite.
 *
 * Read-only, and against the same index the deployment queries.
 */
async function checkLiveKbScope() {
  const url = process.env.HYBRID_UPSTASH_VECTOR_REST_URL ?? process.env.UPSTASH_VECTOR_REST_URL;
  const token = process.env.HYBRID_UPSTASH_VECTOR_REST_TOKEN ?? process.env.UPSTASH_VECTOR_REST_TOKEN;
  if (!url || !token) return skip("live KB scope", "no vector credentials in the environment");
  if (BRAND !== "getsign") return skip("live KB scope", "the main profile applies no filter by design");

  const query = async (filter?: string) => {
    // `/query-data`, not `/query`: the index embeds the text for us. `/query`
    // expects a raw vector and rejects a `data` payload, which is a query
    // failure that looks exactly like an index with no metadata.
    const res = await fetch(`${url}/query-data`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        data: "how do I send a document for signature",
        topK: 8,
        includeMetadata: true,
        ...(filter ? { filter } : {}),
      }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { result?: { metadata?: Record<string, unknown> }[] };
    return j.result ?? [];
  };

  const unscoped = await query();
  const scoped = await query('product IN ("getsign","shared")');
  if (!unscoped || !scoped) return check("the live index answers a scoped query", false, "query failed");

  // The gate that was blocking rollout: an index with no `product` metadata
  // accepts the filter and returns nothing.
  check("the live index returns hits under the GetSign scope", scoped.length > 0, `${scoped.length} hits`);
  check(
    "every scoped hit is a GetSign or shared article",
    scoped.every((h) => ["getsign", "shared"].includes(String(h.metadata?.product ?? ""))),
    scoped.map((h) => String(h.metadata?.product)).join(", "),
  );
  // …and the filter is doing work rather than matching everything. If the
  // unscoped index holds nothing but getsign/shared, the assertion above is
  // true for a reason that has nothing to do with the filter.
  const otherBrandExists = (unscoped ?? []).length > 0;
  check(
    "the index is populated enough for the scope to mean anything",
    otherBrandExists,
    `${unscoped.length} unscoped hits`,
  );
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
    custom_fields?: Record<string, unknown>;
    conversations?: { private: boolean; body_text: string }[];
  };
  check("the ticket exists in Freshdesk", true);
  check("the subject carries through", /E2E/.test(t.subject), t.subject);

  // Product attribution, round-tripped through a live create for the first
  // time. CF_PRODUCT_LABELS was transcribed from the ticket form and never
  // confirmed, and createTicket RETRIES WITHOUT THE FIELD when Freshdesk
  // rejects a label — so a wrong label costs attribution silently and the
  // ticket still arrives. Reading it back is the only way to know.
  if (BRANDED && BRAND === "getsign") {
    const cf = t.custom_fields?.cf_product;
    check(
      "the ticket is attributed to GetSign (cf_product)",
      cf === "GetSign",
      `cf_product = ${JSON.stringify(cf)} — the label in CF_PRODUCT_LABELS may not match the FD dropdown`,
    );
  }
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
