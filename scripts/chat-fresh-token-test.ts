/**
 * Offline test for monday's session token in chat: asked for when a session
 * opens, checked again when a saved chat is resumed, and never left lying on
 * the page.
 *
 *   npx tsx scripts/chat-fresh-token-test.ts
 *
 * The loader (public/jettachat.js) runs in node:vm against a stub page, as in
 * chat-launcher-test.ts. Stub mode, no credentials.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

// Before ANY import: lib/config.ts snapshots process.env on first load.
process.env.STUB_MODE = "true";
process.env.JETTACHAT_LIVE = "true";
process.env.JETTACHAT_SECRET = "fresh-token-test-secret-do-not-use-in-prod";
process.env.MONDAY_CLIENT_SECRET_GETSIGN = "getsign-client-secret-for-tests";
process.env.MONDAY_CLIENT_SECRET_VLOOKUP = "vlookup-client-secret-for-tests";
process.env.MONDAY_APP_ID_GETSIGN = "55";
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "KV_URL", "UPSTASH_VECTOR_REST_URL", "UPSTASH_VECTOR_REST_TOKEN", "OPENROUTER_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "ANTHROPIC_API_KEY"]) {
  delete process.env[k];
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function mint(payload: Record<string, unknown>, secret = "getsign-client-secret-for-tests"): string {
  const signed = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  return `${signed}.${crypto.createHmac("sha256", secret).update(signed).digest("base64url")}`;
}

type Msg = Record<string, unknown> & { type?: string; visitor?: Record<string, unknown> };

/** An element that accepts anything the loader does to it. */
function el(tagName: string): Record<string, unknown> {
  return {
    tagName,
    style: { cssText: "" },
    children: [] as unknown[],
    dataset: {},
    innerHTML: "",
    appendChild(c: unknown) {
      (this.children as unknown[]).push(c);
      return c;
    },
    setAttribute() {},
    removeAttribute() {},
    addEventListener() {},
  };
}

/** Run the loader on a stub page; `send` is the chat frame talking to it. */
function boot(jettaConfig: Record<string, unknown>) {
  const posted: Msg[] = [];
  const timeouts: (() => void)[] = [];
  const frameWindow = { postMessage: (m: Msg) => posted.push(m) };
  let onMessage: ((e: unknown) => void) | null = null;
  const script = el("script");
  script.src = "https://jetta.example.com/jettachat.js";
  const created: Record<string, unknown>[] = [];
  const win: Record<string, unknown> = {
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      if (type === "message") onMessage = fn;
    },
    innerWidth: 1280,
    parent: {},
    JettaChatConfig: jettaConfig,
  };
  win.window = win;
  const sandbox = {
    window: win,
    document: {
      currentScript: script,
      readyState: "complete",
      body: el("body"),
      head: el("head"),
      createElement: (t: string) => {
        const e = el(t);
        created.push(e);
        return e;
      },
      querySelector: () => null,
      addEventListener: () => {},
    },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { href: "https://acme.monday.com/boards/777", hostname: "acme.monday.com" },
    URL,
    console,
    requestAnimationFrame: (fn: () => void) => fn(),
    // Recorded, not run, so the "monday never answers" case can be fired by hand.
    setTimeout: (fn: () => void) => timeouts.push(fn),
    clearTimeout: () => {},
    encodeURIComponent,
  };
  runInContext(readFileSync("public/jettachat.js", "utf8"), createContext(sandbox));
  created.find((e) => e.tagName === "iframe")!.contentWindow = frameWindow;
  const send = async (type: string) => {
    onMessage?.({ origin: "https://jetta.example.com", source: frameWindow, data: { type } });
    await new Promise((r) => setImmediate(r));
  };
  const last = (type: string) => posted.filter((m) => m.type === type).at(-1);
  return { send, last, posted, timeouts, win };
}

async function main() {
  let n = 0;
  const check = (name: string, ok: unknown) => {
    assert.ok(ok, name);
    n++;
  };

  // ── The loader: a token function is called per session ──
  let calls = 0;
  const viaFn = boot({
    surface: "monday",
    visitor: { name: "Ada", mondayBoardId: "777", app: "getsign" },
    getMondaySessionToken: () => Promise.resolve({ data: `token-${++calls}` }),
  });
  check("nothing is asked of monday until the frame is ready", calls === 0);
  await viaFn.send("jettachat:ready");
  const init = viaFn.last("jettachat:init");
  check("the frame gets a token fetched at that moment, from the SDK's { data } shape", init?.visitor?.mondaySessionToken === "token-1" && init.visitor.mondayBoardId === "777");
  check("and is told it may ask again", init?.freshIdentity === true);
  await viaFn.send("jettachat:identity");
  check("asking again fetches a NEW token, not the one from page load", viaFn.last("jettachat:identity")?.visitor?.mondaySessionToken === "token-2");
  check("the token is not written onto the page's config", !JSON.stringify((viaFn.win.JettaChatConfig as { visitor: unknown }).visitor).includes("token-"));

  // A bare string works too.
  const bare = boot({ visitor: { app: "getsign" }, getMondaySessionToken: () => "plain-token" });
  await bare.send("jettachat:ready");
  check("a function returning the token itself works", bare.last("jettachat:init")?.visitor?.mondaySessionToken === "plain-token");

  // monday fails or never answers: the chat still opens, unverified.
  const failing = boot({ visitor: { name: "Ada" }, getMondaySessionToken: () => Promise.reject(new Error("no sdk")) });
  await failing.send("jettachat:ready");
  check("a failing token function still opens the chat, without a token", failing.last("jettachat:init")?.visitor?.name === "Ada" && !("mondaySessionToken" in failing.last("jettachat:init")!.visitor!));
  const throwing = boot({ visitor: { name: "Ada" }, getMondaySessionToken: () => { throw new Error("boom"); } });
  await throwing.send("jettachat:ready");
  check("so does one that throws", !!throwing.last("jettachat:init"));
  const silent = boot({ visitor: { name: "Ada" }, getMondaySessionToken: () => new Promise(() => {}) });
  await silent.send("jettachat:ready");
  check("one that never answers holds the chat only until the timeout", !silent.last("jettachat:init"));
  silent.timeouts.forEach((fn) => fn());
  check("and then it opens without a token", silent.last("jettachat:init")?.visitor?.name === "Ada" && !("mondaySessionToken" in silent.last("jettachat:init")!.visitor!));

  // ── The loader: a token given as a plain value is used once and removed ──
  const fixedConfig = { visitor: { name: "Ada", mondaySessionToken: "page-load-token" } };
  const fixed = boot(fixedConfig);
  check("a token on the page's config is taken off it as soon as the loader runs", !("mondaySessionToken" in fixedConfig.visitor));
  await fixed.send("jettachat:ready");
  check("it still reaches the frame, once", fixed.last("jettachat:init")?.visitor?.mondaySessionToken === "page-load-token");
  await fixed.send("jettachat:identity");
  check("and is not handed out a second time, stale", !("mondaySessionToken" in fixed.last("jettachat:identity")!.visitor!));
  (fixed.win.JettaChat as { identify: (v: unknown) => void }).identify({ mondaySessionToken: "from-identify", name: "Ada L" });
  await fixed.send("jettachat:identity");
  const afterIdentify = fixed.last("jettachat:identity")!.visitor!;
  check("identify() can supply a newer one, also used once", afterIdentify.mondaySessionToken === "from-identify" && afterIdentify.name === "Ada L");
  await fixed.send("jettachat:identity");
  check("then it is gone again", !("mondaySessionToken" in fixed.last("jettachat:identity")!.visitor!));

  // ── The frame keeps its side of it ──
  const frameSrc = readFileSync("app/chat/page.tsx", "utf8");
  check("a resumed session sends the token", /conversationId: attempt\.session\.conversationId,[\s\S]{0,400}mondaySessionToken: mondayToken\(attempt\.visitor\)/.test(frameSrc));
  check("the frame does not hold the token after opening", /initRef\.current = \{ \.\.\.init, visitor: withoutToken\(init\.visitor\) \}/.test(frameSrc));
  check("a new chat asks the page for the visitor again", /post\("jettachat:identity"\)/.test(frameSrc));

  // ── The rule for a resumed conversation ──
  const { reverifiedVisitor } = await import("../lib/chat-visitor");
  const tok = { app: "getsign" as const, accountId: "123456", accountSlug: "acme", userId: "9", strict: true };
  const NOW = 1_800_000_000;
  const up = reverifiedVisitor({ name: "Ada", email: "ada@acme.example" }, tok, "777", NOW);
  check("an anonymous saved chat becomes verified, keeping what was typed", up?.mondayAccountVerified === true && up.mondayAccountId === "123456" && up.mondayAccountSlug === "acme" && up.mondayUserId === "9" && up.mondayTokenStrict === true && up.mondayVerifiedAt === NOW && up.mondayBoardId === "777" && up.app === "getsign" && up.name === "Ada");
  const claimed = reverifiedVisitor({ mondayAccountId: "123456", mondayAccountSlug: "typed-slug", mondayUserId: "9", app: "getsign" }, tok, undefined, NOW);
  check("a claimed account that matches is confirmed, with the token's slug", claimed?.mondayAccountVerified === true && claimed.mondayAccountSlug === "acme");
  check("a different account is left alone", reverifiedVisitor({ mondayAccountId: "999" }, tok, "777", NOW) === null);
  check("a different user on the same account is left alone", reverifiedVisitor({ mondayAccountId: "123456", mondayUserId: "10" }, tok, "777", NOW) === null);
  check("a chat about another app is left alone", reverifiedVisitor({ app: "vlookup" }, tok, "777", NOW) === null);
  check("a token with no account is nothing", reverifiedVisitor({}, { app: "getsign", strict: true }, "777", NOW) === null);
  check("a looser token does not renew a strict verification", reverifiedVisitor({ mondayAccountId: "123456", mondayAccountVerified: true, mondayTokenStrict: true, mondayVerifiedAt: NOW - 90_000 }, { ...tok, strict: false }, "777", NOW) === null);
  const moved = reverifiedVisitor({ mondayAccountId: "123456", mondayAccountVerified: true, mondayTokenStrict: true, mondayVerifiedAt: NOW - 90_000, mondayBoardId: "777", app: "getsign" }, tok, "888", NOW);
  check("a verified chat is renewed, and follows the board now in view", moved?.mondayVerifiedAt === NOW && moved.mondayBoardId === "888");
  check("a board id that is not a number keeps the old one", reverifiedVisitor({ mondayBoardId: "777" }, tok, "8; drop", NOW)?.mondayBoardId === "777");

  // ── The session route ──
  const { NextRequest } = await import("next/server");
  const { POST } = await import("../app/api/chat/session/route");
  const { getConversation } = await import("../lib/chat-store");
  const { mayReadAppState } = await import("../lib/tools/getsign-app");
  const call = async (body: unknown) => {
    const res = await POST(new NextRequest("https://jetta.test/api/chat/session", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.41" }, body: JSON.stringify(body) }));
    return { status: res.status, json: (await res.json()) as { conversationId?: string; token?: string } };
  };
  const exp = Math.floor(Date.now() / 1000) + 300;
  const good = mint({ exp, dat: { account_id: 123456, user_id: 9, slug: "acme", app_id: 55 } });

  // A chat saved before the app passed any token.
  const old = (await call({ surface: "monday", visitor: { name: "Ada", mondayAccountId: "123456", mondayUserId: "9", app: "getsign" } })).json;
  const before = await getConversation(old.conversationId!);
  check("opened without a token it is only a claim", before?.visitor.mondayAccountVerified !== true && !mayReadAppState(before!));
  const resumed = await call({ conversationId: old.conversationId, token: old.token, mondaySessionToken: good, mondayBoardId: "777" });
  const after = await getConversation(old.conversationId!);
  check("resumed with a good token it is verified", resumed.status === 200 && after?.visitor.mondayAccountVerified === true && after.visitor.mondayTokenStrict === true && after.visitor.mondayBoardId === "777" && mayReadAppState(after));
  check("resuming did not count as activity", after?.lastActivityAt === before?.lastActivityAt);

  // The things that must not work.
  await call({ conversationId: old.conversationId, token: old.token, mondaySessionToken: mint({ exp, dat: { account_id: 555, user_id: 9, slug: "other", app_id: 55 } }) });
  check("a token for another account changes nothing", (await getConversation(old.conversationId!))?.visitor.mondayAccountId === "123456");
  const plain = (await call({ surface: "monday", visitor: { app: "getsign" } })).json;
  await call({ conversationId: plain.conversationId, token: plain.token, mondaySessionToken: mint({ exp, dat: { account_id: 123456, slug: "acme", app_id: 55 } }, "not-the-secret") });
  check("a forged token changes nothing", (await getConversation(plain.conversationId!))?.visitor.mondayAccountVerified !== true);
  await call({ conversationId: plain.conversationId, token: plain.token, mondaySessionToken: mint({ exp: exp - 4000, dat: { account_id: 123456, slug: "acme", app_id: 55 } }) });
  check("an expired token changes nothing", (await getConversation(plain.conversationId!))?.visitor.mondayAccountVerified !== true);
  await call({ conversationId: plain.conversationId, token: plain.token, mondayAccountId: "123456", mondayAccountVerified: true, mondayTokenStrict: true, mondayBoardId: "777" });
  const stillPlain = await getConversation(plain.conversationId!);
  check("claims with no token change nothing, the board included", stillPlain?.visitor.mondayAccountVerified !== true && stillPlain?.visitor.mondayBoardId === undefined);
  const denied = await call({ conversationId: old.conversationId, token: "wrong", mondaySessionToken: good });
  check("a good monday token does not open someone else's chat", denied.status === 403);

  console.log(`chat-fresh-token: ${n} checks passed.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
