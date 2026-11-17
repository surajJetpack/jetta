/**
 * Offline test for the customer's own GetSign setup in chat
 * (lib/tools/getsign-app.ts): who it is read for, what can reach the prompt,
 * and that Jetta is told to use it without announcing it.
 *
 *   npx tsx scripts/app-state-test.ts
 *
 * Runs in stub mode with no credentials. The GetSign backend is stood in for.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";

// Before ANY import: lib/config.ts snapshots process.env on first load.
process.env.STUB_MODE = "true";
process.env.JETTACHAT_LIVE = "true";
process.env.JETTACHAT_SECRET = "app-state-test-secret-do-not-use-in-prod";
process.env.MONDAY_CLIENT_SECRET_GETSIGN = "getsign-client-secret-for-tests";
process.env.MONDAY_CLIENT_SECRET_VLOOKUP = "vlookup-client-secret-for-tests";
process.env.MONDAY_APP_ID_GETSIGN = "55";
process.env.GETSIGN_API_BASE_URL = "https://backend.test/";
process.env.GETSIGN_SUPPORT_KEY = "support-key-for-tests";
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "KV_URL", "UPSTASH_VECTOR_REST_URL", "UPSTASH_VECTOR_REST_TOKEN", "OPENROUTER_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "ANTHROPIC_API_KEY"]) {
  delete process.env[k];
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function mint(payload: Record<string, unknown>, secret: string): string {
  const signed = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  return `${signed}.${crypto.createHmac("sha256", secret).update(signed).digest("base64url")}`;
}

async function main() {
  const { config } = await import("../lib/config");
  const app = await import("../lib/tools/getsign-app");
  const { sanitizeAppState, renderAppState, mayReadAppState, getAppState, appStateForChat, SUPPORT_KEY_HEADER } = app;
  const { verifyMondaySessionToken, strictSession } = await import("../lib/monday-session-token");
  const { buildSystemPrompt } = await import("../lib/system-prompt");
  const { getOpsEvents } = await import("../lib/events");
  type ChatConversation = import("../lib/types").ChatConversation;
  const setMode = (m: "off" | "shadow" | "on") => ((config as { appState: string }).appState = m);

  let n = 0;
  const check = (name: string, ok: unknown) => {
    assert.ok(ok, name);
    n++;
  };

  // What a backend might send, including things it must never send.
  const RAW = {
    account: { status: "paid", installState: "installed", timeZone: "Europe/London", remindersEnabled: true, reminderHours: [24, 48], otpRequired: false, senderEmailSet: true, senderEmail: "owner@acme.example", accessToken: "SECRET-TOKEN" },
    plan: { name: "Basic", isTrial: false, daysLeft: null, features: { signing_order: false, auto_send: true, "bad key!": true }, usage: { sent: 38, generated: 120, sendLimit: 100, generateLimit: 500 } },
    workflows: [
      {
        id: "64f0c0ffee",
        name: "Contracts",
        type: "template",
        status: "template-created",
        signatureCollection: true,
        recipientColumns: [],
        signingOrderRequired: false,
        autoSend: { column: "Status", value: "Send" },
        remindersEnabled: true,
        reminderHours: [24],
        linkExpiryMinutes: null,
        senderEmailVerified: false,
        templates: [{ name: "NDA", type: "docx", htmlContent: "<p>CONFIDENTIAL TEXT</p>", file: "https://files.example/secret.pdf" }],
        signers: [{ email: "signer@customer.example", label: "Client" }],
      },
      { type: "template" },
    ],
    sessions: { total: 12, completed: 9, awaiting: 3, recent: [{ itemName: "Acme deal", status: "sent", at: "2026-11-16T10:00:00Z", sentToEmail: ["signer@customer.example"], viewedIpAddress: "203.0.113.5" }] },
    failures: [{ kind: "generate", message: "Column not found for jane@customer.example on the board", itemName: "Acme deal", at: "2026-11-15T09:00:00Z" }],
    signers: [{ email: "other@customer.example" }],
  };

  // ── The allow-list ──
  const state = sanitizeAppState(RAW)!;
  const flat = JSON.stringify(state);
  check("nothing shaped like an email address survives", !flat.includes("@"));
  check("no token, document text, file link, IP address or signer survives", !/SECRET-TOKEN|CONFIDENTIAL|files\.example|203\.0\.113|signer|Client/.test(flat));
  check("an email inside a failure message is masked, the message kept", state.failures[0].message === "Column not found for [email] on the board");
  check("no internal id is copied", !flat.includes("64f0c0ffee"));
  check("the facts that matter are kept", state.plan.name === "Basic" && state.plan.features.signing_order === false && state.workflows[0].recipientColumns.length === 0 && state.workflows[0].senderEmailVerified === false);
  check("a feature name that is not a plain word is dropped", !("bad key!" in state.plan.features));
  check("a workflow with no name is dropped", state.workflows.length === 1);
  check("a reply that is not an object is nothing", sanitizeAppState("oops") === null && sanitizeAppState(null) === null && sanitizeAppState([1]) === null);
  check("an empty object is an empty state, not a crash", sanitizeAppState({})!.workflows.length === 0);

  const shown = renderAppState(state);
  check("the block says what the plan lacks", shown.includes("NOT included in their plan: signing_order"));
  check("and what is wrong with the workflow", shown.includes(`"Contracts"`) && shown.includes("NO column is mapped for the signer's email") && shown.includes("sender email NOT verified"));
  check("usage is shown against the limit", shown.includes("38 sent of 100"));
  check("the rendered block has no email address either", !shown.includes("@"));

  // ── Who it is read for ──
  const NOW = new Date("2026-11-17T12:00:00Z");
  const at = Math.floor(NOW.getTime() / 1000);
  const conv = (visitor: Partial<ChatConversation["visitor"]>, id = "c1"): ChatConversation =>
    ({ id, visitor: { app: "getsign", mondayAccountId: "123456", mondayAccountVerified: true, mondayTokenStrict: true, mondayVerifiedAt: at - 60, mondayBoardId: "777", ...visitor } }) as never;
  check("a visitor monday vouched for, strictly and recently", mayReadAppState(conv({}), NOW));
  check("not a claimed account", !mayReadAppState(conv({ mondayAccountVerified: undefined }), NOW));
  check("not a token without the strict checks", !mayReadAppState(conv({ mondayTokenStrict: undefined }), NOW));
  check("not another app", !mayReadAppState(conv({ app: "vlookup" }), NOW));
  check("not a verification older than a day", !mayReadAppState(conv({ mondayVerifiedAt: at - 25 * 3600 }), NOW));
  check("not without an account id", !mayReadAppState(conv({ mondayAccountId: undefined }), NOW));

  // ── The token ──
  const soon = at + 300;
  const good = verifyMondaySessionToken(mint({ exp: Math.floor(Date.now() / 1000) + 300, dat: { account_id: 123456, user_id: 9, slug: "acme", app_id: 55 } }, "getsign-client-secret-for-tests"));
  check("a GetSign token with an expiry and the right app id is strict", !!good && strictSession(good, "55") && good.appId === "55" && typeof good.expiresAt === "number");
  check("the wrong app id is not", !strictSession(good, "99"));
  const noExp = verifyMondaySessionToken(mint({ dat: { account_id: 123456, slug: "acme", app_id: 55 } }, "getsign-client-secret-for-tests"));
  check("a token with no expiry still verifies, as before, but is not strict", !!noExp && !strictSession(noExp, "55"));
  check("no token is not strict", !strictSession(null, "55"));
  void soon;

  // ── The session route stores the token's word, not the page's ──
  const { NextRequest } = await import("next/server");
  const { POST } = await import("../app/api/chat/session/route");
  const { getConversation } = await import("../lib/chat-store");
  const open = async (body: unknown) => {
    const res = await POST(new NextRequest("https://jetta.test/api/chat/session", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.40" }, body: JSON.stringify(body) }));
    const id = ((await res.json()) as { conversationId?: string }).conversationId;
    return id ? await getConversation(id) : null;
  };
  const token = mint({ exp: Math.floor(Date.now() / 1000) + 300, dat: { account_id: 123456, user_id: 9, slug: "acme", app_id: 55 } }, "getsign-client-secret-for-tests");
  const signedIn = await open({ surface: "monday", visitor: { mondaySessionToken: token, mondayAccountId: "999999", mondayAccountSlug: "someone-else", mondayBoardId: "777", app: "getsign" } });
  check("the account stored is the token's, whatever the page claimed", signedIn?.visitor.mondayAccountId === "123456" && signedIn.visitor.mondayAccountSlug === "acme");
  check("it is marked strict and timestamped, and the board is kept", signedIn?.visitor.mondayTokenStrict === true && typeof signedIn.visitor.mondayVerifiedAt === "number" && signedIn.visitor.mondayBoardId === "777");
  check("so its app state may be read", !!signedIn && mayReadAppState(signedIn));
  const claimed = await open({ surface: "monday", visitor: { mondayAccountId: "123456", mondayAccountSlug: "acme", mondayBoardId: "777", app: "getsign", mondayTokenStrict: true, mondayVerifiedAt: at, mondayAccountVerified: true } });
  check("a page that only CLAIMS all of that gets nothing", !!claimed && claimed.visitor.mondayAccountVerified !== true && claimed.visitor.mondayTokenStrict !== true && claimed.visitor.mondayVerifiedAt === undefined && !mayReadAppState(claimed));
  const wrongApp = await open({ surface: "monday", visitor: { mondaySessionToken: mint({ exp: Math.floor(Date.now() / 1000) + 300, dat: { account_id: 5, slug: "x", app_id: 1 } }, "getsign-client-secret-for-tests"), app: "getsign" } });
  check("a token for another app id verifies the account but does not unlock app state", wrongApp?.visitor.mondayAccountVerified === true && !mayReadAppState(wrongApp));
  const board = await open({ surface: "monday", visitor: { mondaySessionToken: token, mondayBoardId: "12; drop" } });
  check("a board id that is not a number is dropped", board?.visitor.mondayBoardId === undefined);

  // ── The request ──
  const calls: { url: string; key: string | null }[] = [];
  let reply: () => Response = () => new Response(JSON.stringify(RAW), { status: 200 });
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), key: new Headers(init?.headers).get(SUPPORT_KEY_HEADER) });
    return reply();
  }) as unknown as typeof fetch;

  const got = await getAppState("123456", "777", fetcher);
  check("one GET to the support route for that account and board, with the key", got.ok && calls.length === 1 && calls[0].url === "https://backend.test/api/v3/internal/support/accounts/123456/state?boardId=777" && calls[0].key === "support-key-for-tests");
  check("an account id that is not a number is never sent", !(await getAppState("123/../9", "777", fetcher)).ok && calls.length === 1);
  await getAppState("123456", "777&x=1", fetcher);
  check("a board id that is not a number is left out", calls.at(-1)!.url.endsWith("/accounts/123456/state"));
  reply = () => new Response("nope", { status: 500 });
  const failed = await getAppState("123456", "777", fetcher);
  check("a backend error is 'failed', never an empty account", !failed.ok && failed.reason === "failed");
  reply = () => {
    throw new Error("network down");
  };
  check("a network failure is 'failed' too, and does not throw", !(await getAppState("123456", "777", fetcher)).ok);
  reply = () => new Response(JSON.stringify(RAW), { status: 200 });

  // ── In a chat ──
  calls.length = 0;
  setMode("off");
  check("off: nothing is read", (await appStateForChat(conv({}, "off1"), { now: NOW, fetcher })) === undefined && calls.length === 0);
  setMode("on");
  check("an unverified visitor: nothing is read", (await appStateForChat(conv({ mondayAccountVerified: undefined }, "u1"), { now: NOW, fetcher })) === undefined && calls.length === 0);
  check("a website visitor with only an email: nothing is read", (await appStateForChat({ id: "w1", visitor: { email: "a@b.example", app: "getsign" } } as never, { now: NOW, fetcher })) === undefined && calls.length === 0);
  const live = await appStateForChat(conv({}, "on1"), { now: NOW, fetcher });
  check("a verified visitor: their state", !!live && live !== "unknown" && live.plan.name === "Basic" && calls.length === 1 && calls[0].url.includes("/accounts/123456/"));
  await appStateForChat(conv({}, "on1"), { now: NOW, fetcher });
  check("the next turn of the same chat does not ask again", calls.length === 1);
  reply = () => new Response("nope", { status: 503 });
  check("a failed lookup is 'unknown'", (await appStateForChat(conv({}, "on2"), { now: NOW, fetcher })) === "unknown");
  reply = () => new Response(JSON.stringify(RAW), { status: 200 });
  setMode("shadow");
  const before = calls.length;
  check("shadow: read and logged, and she is shown nothing", (await appStateForChat(conv({}, "sh1"), { now: NOW, fetcher })) === undefined && calls.length === before + 1 && (await getOpsEvents({})).some((e) => e.event === "appstate.shadow"));

  // ── The prompt ──
  const ctx = (chat: object, product = "getsign") =>
    ({ channel: "jettachat", ticket: { id: "conv-1", subject: "s", description: "d", status: "open", replies: [] }, account: null, relatedDevItems: [], product, appProduct: product, app: product, chat: { surface: "monday", handoffEnabled: true, needsIdentity: false, ...chat } }) as never;
  setMode("off");
  const baseline = await buildSystemPrompt(ctx({}));
  check("off: the prompt knows nothing of any of this", !/THEIR OWN SETUP|do not have this visitor's own GetSign setup|GETSIGN ACCOUNT SHOWS/.test(baseline));
  setMode("on");
  const withState = await buildSystemPrompt(ctx({ appState: state }));
  check("with the state: the block is in the prompt", withState.includes("WHAT THIS CUSTOMER'S OWN GETSIGN ACCOUNT SHOWS") && withState.includes(`"Contracts"`));
  check("and the rule to use it", withState.includes("THEIR OWN SETUP IS KNOWN"));
  check("and never to announce it", /Do NOT say or imply that you looked,\s+checked/.test(withState));
  check("the grounding rule's exception is narrow: steps still need an article", /still come\s+only from a knowledge base article/.test(withState));
  check("no email address reaches the prompt", !withState.includes("customer.example") && !withState.includes("acme.example"));
  check("a failed lookup changes nothing in the prompt", (await buildSystemPrompt(ctx({ appState: "unknown" }))) === baseline);
  const noState = await buildSystemPrompt(ctx({}));
  check("on, but not verified: she is told she has no setup to go on, and to ask", noState.includes("You do not have this visitor's own GetSign setup") && noState.includes("Never ask for a password"));
  check("and that is only said for GetSign", !(await buildSystemPrompt(ctx({}, "jetpackapps"))).includes("own GetSign setup"));
  setMode("shadow");
  check("shadow: the prompt is exactly the off prompt", (await buildSystemPrompt(ctx({}))) === baseline);

  console.log(`app-state: all ${n} assertions passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
