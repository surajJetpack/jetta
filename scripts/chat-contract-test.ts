/**
 * JettaChat contract tests — the guarantees the widget and the routes rely on,
 * checked without a network or a model.
 *
 * These cover the class of bug that shipped three times in one week and was
 * invisible every time: a token that verifies when it shouldn't, an origin rule
 * that lets the wrong site embed the chat, a lost update that drops a
 * customer's message, a state machine that lets Jetta talk over a colleague.
 * None of it is caught by `tsc`, and none of it is visible in a browser until a
 * customer finds it.
 *
 *   npx tsx scripts/chat-contract-test.ts
 *   npx tsx --env-file=.env.local scripts/chat-contract-test.ts --kv
 *
 * WITHOUT --kv (the default) the KV credentials are stripped from the
 * environment before anything is imported, so the suite runs entirely in the
 * in-memory fallback. That is not just for speed: `saveChatSettings` PERSISTS,
 * and a clamp test run against live KV would overwrite the real widget's
 * settings. The default is therefore the safe one, and `--kv` narrows to the
 * two checks that genuinely need a shared store (the write lock), using a
 * throwaway conversation it deletes afterwards.
 */
// Marks this file a module. Without it, `tsc --noEmit` treats every script with
// no top-level import as one global scope, and the `check` helper every test
// script defines collides with the next one's.
export {};

const USE_KV = process.argv.includes("--kv");

// Set before ANY import: lib/config.ts snapshots process.env the first time it
// is loaded, so every module below is imported dynamically inside main().
process.env.STUB_MODE = "true";
process.env.JETTACHAT_LIVE = "true";
process.env.JETTACHAT_SECRET = "contract-test-secret-do-not-use-in-prod";
process.env.JETTACHAT_DEBOUNCE_SECONDS = "0";
process.env.JETTACHAT_ALLOWED_ORIGINS = "";

const KV_VARS = [
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_URL",
];
if (!USE_KV) for (const v of KV_VARS) delete process.env[v];

// Nothing in this suite should reach a model or an integration, in either mode.
// --kv is run with --env-file=.env.local (that is the only way to get the KV
// credentials), which also hands over every live key in the file — so they are
// dropped explicitly here. Without this, the two crash-path checks below stop
// being crash-path checks: they spend a real agent loop, search the live KB,
// and prove nothing about what happens when a run fails.
for (const v of [
  "OPENROUTER_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "ANTHROPIC_API_KEY",
]) {
  delete process.env[v];
}
process.env.FRESHDESK_LIVE = "false";
process.env.SLACK_LIVE = "false";
process.env.MONDAY_LIVE = "false";
process.env.MONDAY_ALLOW_WRITES = "false";

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

async function main() {
  const store = await import("../lib/chat-store");
  const settings = await import("../lib/chat-settings");
  const files = await import("../lib/chat-files");
  const { config } = await import("../lib/config");
  const { toChatText } = await import("../lib/tools/jettachat");

  const kvLive = !!(config.kv.url && config.kv.token);

  // Every conversation this suite creates is tracked so that a --kv run leaves
  // the real store exactly as it found it. A test transcript in the console
  // inbox is indistinguishable from a customer's until someone opens it.
  const created: string[] = [];
  const newConv = async (name: string, email: string) => {
    const c = await store.createConversation({ surface: "wordpress", visitor: { name, email } });
    created.push(c.id);
    return c;
  };
  const forgetConversations = async () => {
    if (!kvLive || !created.length) return;
    const { Redis } = await import("@upstash/redis");
    const redis = new Redis({ url: config.kv.url!, token: config.kv.token! });
    for (const id of created) {
      await redis.del(`jetta:chat:${id}`);
      await redis.zrem("jetta:chats", id);
    }
    const survivors = (await Promise.all(created.map((id) => store.getConversation(id)))).filter(
      Boolean,
    );
    check(
      `all ${created.length} test conversations removed from KV`,
      survivors.length === 0,
      `${survivors.length} left behind`,
    );
  };

  // ── Conversation tokens ──────────────────────────────────────────
  //
  // The token is the ONLY thing standing between a guessed UUID and someone
  // else's transcript. There is no session, no cookie and no login on this
  // channel.
  section("Conversation tokens");
  const idA = "11111111-1111-4111-8111-111111111111";
  const idB = "22222222-2222-4222-8222-222222222222";
  const tokenA = store.signToken(idA);

  check("a freshly signed token verifies", store.verifyToken(idA, tokenA));
  check("a tampered token is rejected", !store.verifyToken(idA, tokenA.slice(0, -1) + "x"));
  check("a truncated token is rejected", !store.verifyToken(idA, tokenA.slice(0, 10)));
  check("an empty token is rejected", !store.verifyToken(idA, ""));
  check("a null token is rejected", !store.verifyToken(idA, null));
  // The one that matters most: conversation ids are guessable-shaped, so a
  // token must be useless anywhere but its own conversation.
  check("conversation A's token does not open conversation B", !store.verifyToken(idB, tokenA));
  check("the token is not the id in disguise", tokenA !== idA && !tokenA.includes(idA));

  // ── Origin allowlist ─────────────────────────────────────────────
  //
  // This decides who may embed the widget. A rule that is too loose is a
  // cross-origin data leak; too tight and the widget silently fails to load on
  // a customer's site.
  section("Origin allowlist");
  const allow = settings.originAllowed;
  check("exact origin matches", allow("https://jetpackapps.io", ["https://jetpackapps.io"]));
  check("a different host does not match", !allow("https://evil.com", ["https://jetpackapps.io"]));
  check("an empty allowlist matches nothing", !allow("https://jetpackapps.io", []));
  check(
    "wildcard matches a subdomain",
    allow("https://myteam.monday.com", ["https://*.monday.com"]),
  );
  check(
    "wildcard does not match the bare apex",
    !allow("https://monday.com", ["https://*.monday.com"]),
  );
  check(
    "wildcard does not match a lookalike suffix",
    !allow("https://evilmonday.com", ["https://*.monday.com"]),
  );
  check(
    "wildcard does not match a different scheme",
    !allow("http://myteam.monday.com", ["https://*.monday.com"]),
  );
  // The rule that stops someone typing a wildcard that opens the widget to the
  // entire internet.
  check("a top-level wildcard is refused", !allow("https://anything.com", ["https://*.com"]));
  check("garbage input does not throw or match", !allow("not-a-url", ["https://*.monday.com"]));

  // ── Public settings ──────────────────────────────────────────────
  //
  // /api/chat/config is unauthenticated by necessity. The named-subset rule is
  // what keeps a later field addition from leaking the allowlist or the limits.
  section("Public settings");
  const full = settings.defaultSettings();
  const pub = settings.publicSettings(full) as Record<string, unknown>;
  for (const secret of [
    "allowedOrigins",
    "rateLimitPerHour",
    "uploadsPerHour",
    "uploadsPerConversation",
    "retentionDays",
    "handoffChannel",
    "handoffTimeoutMinutes",
    "enabled",
    "updatedBy",
  ]) {
    check(`publicSettings withholds ${secret}`, !(secret in pub));
  }
  check("publicSettings still carries the greeting", typeof pub.greeting === "string");
  check("publicSettings still carries requireIdentity", typeof pub.requireIdentity === "boolean");

  // ── Settings clamping ────────────────────────────────────────────
  //
  // Numbers are clamped rather than rejected, so a typo cannot both lose the
  // form and — for the two limits guarding a public endpoint — cannot raise the
  // ceiling either.
  section("Settings clamping");
  if (kvLive) {
    skip("clamping", "KV is live and saveChatSettings persists — run without --kv");
  } else {
    const saved = await settings.saveChatSettings(
      {
        debounceSeconds: 9999,
        rateLimitPerHour: 10_000_000,
        uploadsPerHour: 5000,
        retentionDays: 100_000,
        maxAttachmentMb: 999,
        autoOpenSeconds: -5,
        accentColor: "not-a-colour",
        allowedOrigins: ["https://site.com/", "https://site.com", " https://*.monday.com/ "],
        avatarUrl: "https://evil.example.com/tracker.png",
      },
      "contract-test",
    );
    check("debounce clamped to 60s", saved.debounceSeconds === 60, String(saved.debounceSeconds));
    check("message rate clamped to 10000", saved.rateLimitPerHour === 10_000, String(saved.rateLimitPerHour));
    check("uploads/hour clamped to 200", saved.uploadsPerHour === 200, String(saved.uploadsPerHour));
    check("retention clamped to 3650 days", saved.retentionDays === 3650, String(saved.retentionDays));
    // 25 MB because Freshdesk refuses more than 20 — a larger file uploads
    // fine and then fails at the hand-off, the one moment it was needed.
    check("attachment size clamped to 25MB", saved.maxAttachmentMb === 25, String(saved.maxAttachmentMb));
    check("negative auto-open floors at 0", saved.autoOpenSeconds === 0, String(saved.autoOpenSeconds));
    check("an invalid accent colour is ignored", saved.accentColor === full.accentColor, saved.accentColor);
    check(
      "origins are normalised and de-duplicated",
      saved.allowedOrigins.length === 2 && saved.allowedOrigins.includes("https://site.com"),
      JSON.stringify(saved.allowedOrigins),
    );
    check(
      "the wildcard entry survives normalisation",
      saved.allowedOrigins.includes("https://*.monday.com"),
      JSON.stringify(saved.allowedOrigins),
    );
    // A remote avatar would make every visitor's browser call a third party
    // from the customer's own site.
    check("a remote avatar URL is refused", saved.avatarUrl === undefined, String(saved.avatarUrl));
    settings.clearSettingsCache();
  }

  // ── Attachment claiming ──────────────────────────────────────────
  //
  // The vision description is prompt text the model trusts, so it is always
  // rehydrated from the server-side record — never from the request body.
  section("Attachment claiming");
  const convForFiles = await newConv("Contract Test", "contract@example.com");
  check(
    "an unknown upload id claims nothing",
    (await files.claimPending(convForFiles.id, ["deadbeef-dead-4bee-8dea-deadbeefdead"])).length === 0,
  );
  check(
    "a malformed upload id is refused outright",
    (await files.claimPending(convForFiles.id, ["../../etc/passwd", "a", ""])).length === 0,
  );
  check("MAX_FILES_PER_MESSAGE is 4", files.MAX_FILES_PER_MESSAGE === 4);
  check(
    "path ownership is checked against the conversation in the URL",
    files.pathBelongsTo(`chat/${convForFiles.id}/abc/shot.png`, convForFiles.id) &&
      !files.pathBelongsTo(`chat/${convForFiles.id}/abc/shot.png`, idB),
  );
  check(
    "a traversing pathname does not pass ownership",
    !files.pathBelongsTo(`chat/${convForFiles.id}/../${idB}/x.png`, idB),
  );

  // ── Transcript rendering ─────────────────────────────────────────
  section("Transcript rendering");
  await store.appendMessage(convForFiles.id, "visitor", "here is the error");
  await store.appendMessage(convForFiles.id, "agent", "Thanks — looking now.");
  await store.appendMessage(convForFiles.id, "agent", "Suraj here, taking over.", {
    via: "human",
    authorName: "Suraj",
  });
  const conv3 = await store.getConversation(convForFiles.id);
  const transcript = store.transcriptText(conv3!);
  check("the visitor is labelled Customer", transcript.includes("Customer: here is the error"));
  check("Jetta's messages are attributed to her", transcript.includes("Jetta: Thanks"));
  // A colleague's message must never read as Jetta's — the transcript is what
  // the Freshdesk hand-off carries, and "Jetta said it" is a different fact.
  check("a colleague's message carries their name", transcript.includes("Suraj: Suraj here"));
  check(
    "transcript order is oldest first",
    transcript.indexOf("here is the error") < transcript.indexOf("taking over"),
  );

  section("Chat text flattening");
  check("markdown links survive", toChatText("see [the guide](https://x.io)").includes("https://x.io"));
  check("toChatText returns a plain string", typeof toChatText("**bold**") === "string");

  // ── Turn supersede (the debounce contract) ───────────────────────
  //
  // A visitor sends a thought as three messages. Exactly one of them may spend
  // an agent loop.
  section("Turn supersede");
  const burst = await newConv("Burst", "burst@example.com");
  const m1 = await store.appendMessage(burst.id, "visitor", "hi");
  await store.setPendingTurn(burst.id, m1!.id);
  check("the only message is the latest turn", await store.isLatestTurn(burst.id, m1!.id));
  const m2 = await store.appendMessage(burst.id, "visitor", "actually my real question is…");
  await store.setPendingTurn(burst.id, m2!.id);
  check("a newer message supersedes the older turn", !(await store.isLatestTurn(burst.id, m1!.id)));
  check("the newest message is the live turn", await store.isLatestTurn(burst.id, m2!.id));

  // ── Handoff state machine ────────────────────────────────────────
  //
  // Two voices answering one visitor is the failure that makes a handoff feel
  // broken. Jetta goes silent from the moment a person is ASKED for, not from
  // the moment one arrives.
  section("Handoff state machine");
  console.log("      (a run reaching the model logs a stack trace here — no key is set, by design)");
  const { runChatTurn } = await import("../lib/chat-run");

  const owned = await newConv("Owned", "owned@example.com");
  const om = await store.appendMessage(owned.id, "visitor", "are you there?");
  await store.setPendingTurn(owned.id, om!.id);
  await store.updateConversation(owned.id, { status: "human" });
  await runChatTurn(owned.id, om!.id);
  const ownedAfter = await store.getConversation(owned.id);
  check(
    "a human-owned conversation gets no message from Jetta",
    ownedAfter!.messages.length === 1,
    `${ownedAfter!.messages.length} messages`,
  );

  const waiting = await newConv("Waiting", "waiting@example.com");
  const wm = await store.appendMessage(waiting.id, "visitor", "can I speak to a person?");
  await store.setPendingTurn(waiting.id, wm!.id);
  await store.updateConversation(waiting.id, {
    status: "waiting_human",
    humanRequestedAt: Date.now(),
  });
  await runChatTurn(waiting.id, wm!.id);
  const waitingAfter = await store.getConversation(waiting.id);
  check(
    "Jetta stays silent while a person is being fetched",
    waitingAfter!.messages.length === 1,
    `${waitingAfter!.messages.length} messages`,
  );
  check("status is still waiting_human", waitingAfter!.status === "waiting_human");

  // …and the exception, which is nobody arriving. A silence that never ends is
  // worse than an apology.
  const timedOut = await newConv("TimedOut", "timedout@example.com");
  const tm = await store.appendMessage(timedOut.id, "visitor", "hello? anyone?");
  await store.setPendingTurn(timedOut.id, tm!.id);
  await store.updateConversation(timedOut.id, {
    status: "waiting_human",
    // Well past any configured timeout (the ceiling is 120 minutes).
    humanRequestedAt: Date.now() - 1000 * 60 * 60 * 24,
  });
  await runChatTurn(timedOut.id, tm!.id);
  const timedOutAfter = await store.getConversation(timedOut.id);
  check(
    "an unanswered handoff reverts to Jetta",
    timedOutAfter!.status === "open",
    timedOutAfter!.status,
  );
  check(
    "the visitor is told, rather than left in silence",
    timedOutAfter!.messages.some((m) => m.author === "agent" && /nobody's free/i.test(m.text)),
    timedOutAfter!.messages.map((m) => m.text).join(" | "),
  );
  // Whatever happens next, the widget must never be left showing "typing…".
  check(
    "the typing indicator is cleared when a run ends",
    !(await store.isRunActive(timedOut.id)),
  );

  // ── What the visitor gets when the loop says nothing ─────────────
  //
  // The branch that got it wrong in production: a turn that asked for a
  // colleague and then went quiet — which is what the prompt tells her to do —
  // was answered with "something went wrong on my end". The bot telling a
  // customer it had broken at the moment it had actually fetched them a person.
  section("Delivery decision");
  const { chooseDelivery } = await import("../lib/chat-run");

  const spoke = chooseDelivery("Here's how to fix it.", ["search_knowledge_base"]);
  check("text from the model is the reply", spoke.kind === "reply" && spoke.text === "Here's how to fix it.");
  check(
    "whitespace-only text is not a reply",
    chooseDelivery("   \n  ", []).kind === "fallback",
  );

  const quietHandoff = chooseDelivery("", ["request_human"]);
  check(
    "going quiet after asking for a person is NOT a crash",
    quietHandoff.kind === "handoff_ack",
    quietHandoff.kind,
  );
  check(
    "the stand-in does not tell the customer the bot broke",
    !/something went wrong/i.test(quietHandoff.text),
    quietHandoff.text,
  );
  // The same hedge the prompt demands of her — a stand-in that over-promised
  // would reintroduce the bug it exists to fix.
  check(
    "the stand-in hedges rather than promising a person",
    /if someone's free/i.test(quietHandoff.text) && !/will be with you shortly/i.test(quietHandoff.text),
    quietHandoff.text,
  );

  const quietTicket = chooseDelivery("", ["create_support_ticket"]);
  check("going quiet after opening a ticket says so", quietTicket.kind === "ticket_ack", quietTicket.kind);
  check("the ticket stand-in promises email, not a person", /email/i.test(quietTicket.text), quietTicket.text);

  check(
    "silence with nothing handed on IS a failure",
    chooseDelivery("", ["search_knowledge_base"]).kind === "fallback",
  );
  check(
    "a person outranks a ticket when the turn did both",
    chooseDelivery("", ["create_support_ticket", "request_human"]).kind === "handoff_ack",
  );

  // ── Tool surface ─────────────────────────────────────────────────
  //
  // add_private_note stored nothing on this channel and scheduled a follow-up
  // that doesn't run here — but it gave the model somewhere to put an answer
  // that isn't the customer. Twice in the eval it researched a question, logged
  // a note, and sent no reply. Same failure that removed reply_to_ticket.
  section("Tool surface");
  const { buildTools } = await import("../lib/tools");
  const toolCtx = (channel: string) =>
    ({
      channel,
      ticket: { id: "conv-1", subject: "s", description: "d", status: "open", replies: [] },
      account: null,
      relatedDevItems: [],
      product: "jetpackapps",
      appProduct: "unknown",
      app: "unknown",
      ...(channel === "jettachat" ? { chat: { surface: "wordpress", handoffEnabled: true } } : {}),
    }) as never;

  const chatTools = Object.keys(buildTools(toolCtx("jettachat"), {} as never));
  const ticketTools = Object.keys(buildTools(toolCtx("freshdesk"), {} as never));
  check("add_private_note is withheld on chat", !chatTools.includes("add_private_note"), chatTools.join(", "));
  check("add_private_note survives on tickets", ticketTools.includes("add_private_note"));
  check("chat keeps a way to resolve", chatTools.includes("close_ticket"));

  // The resolution signal add_private_note used to carry has to live somewhere,
  // or every chat silently reports unresolved.
  const signals = { resolutionSent: false };
  const closeTool = buildTools(toolCtx("jettachat"), signals as never).close_ticket as unknown as {
    execute: (a: unknown) => Promise<string>;
  };
  await closeTool.execute({});
  check("resolving a chat records the resolution", signals.resolutionSent === true);

  // ── The monday app view ──────────────────────────────────────────
  //
  // The whole point of embedding inside the app rather than on the site is that
  // the visitor arrives with their account attached. That advantage exists in
  // exactly one place — two lines of the system prompt — and it is invisible
  // everywhere else: the session succeeds, the reply looks fine, and the only
  // symptom of losing it is Jetta asking a logged-in customer for the monday
  // URL she was already handed.
  section("monday app view");
  const { buildSystemPrompt } = await import("../lib/system-prompt");
  const promptCtx = (chat: Record<string, unknown>) =>
    ({
      channel: "jettachat",
      ticket: null,
      account: null,
      relatedDevItems: [],
      product: "jetpackapps",
      appProduct: "getsign",
      app: "getsign",
      chat,
    }) as never;

  const mondayPrompt = await buildSystemPrompt(
    promptCtx({ surface: "monday", mondayAccountSlug: "mallasrj01s-team", handoffEnabled: true }),
  );
  check(
    "the prompt says the widget is inside the customer's monday account",
    /inside the customer's monday\.com account/i.test(mondayPrompt),
  );
  check("the prompt carries the account slug", mondayPrompt.includes("mallasrj01s-team"));
  check(
    "the prompt forbids asking for a monday URL it already has",
    /do NOT ask the customer for their monday URL/i.test(mondayPrompt),
  );

  // The negative half. Without it the two checks above pass on a prompt that
  // says this to everyone, which would be worse than saying it to nobody: a
  // WordPress visitor has no account attached, and inventing one is a lie the
  // trial and discount tools would then act on.
  const sitePrompt = await buildSystemPrompt(promptCtx({ surface: "wordpress", handoffEnabled: true }));
  check(
    "a site visitor gets no monday account line",
    !/monday account:/i.test(sitePrompt) && !/inside the customer's monday\.com account/i.test(sitePrompt),
  );

  // ── Silence is a bug ─────────────────────────────────────────────
  //
  // Every exit path from a run either sends something or opens a ticket. With
  // no model key configured the agent loop throws immediately, which is exactly
  // the crash path this guarantee exists for.
  section("Never leave the visitor hanging");
  console.log("      (the stack traces below are deliberate — this IS the crash path)");
  const crashed = await newConv("Crash", "crash@example.com");
  const cm = await store.appendMessage(crashed.id, "visitor", "my board is blank");
  await store.setPendingTurn(crashed.id, cm!.id);
  await runChatTurn(crashed.id, cm!.id);
  const crashedAfter = await store.getConversation(crashed.id);
  const lastMsg = crashedAfter!.messages.at(-1);
  check(
    "a failed run still says something to the visitor",
    crashedAfter!.messages.length > 1 && lastMsg?.author === "agent",
    `${crashedAfter!.messages.length} messages, last from ${lastMsg?.author}`,
  );
  check("the typing indicator is cleared after a failure", !(await store.isRunActive(crashed.id)));

  // ── Write lock (needs a shared store) ────────────────────────────
  //
  // The in-memory fallback hands back the same object every read, so it cannot
  // reproduce a lost update by construction — this one is only meaningful
  // against real KV.
  section("Concurrent writes");
  if (!kvLive) {
    skip(
      "lost-update regression",
      "no KV configured — rerun with --env-file=.env.local --kv",
    );
  } else {
    const raced = await newConv("Race", "race@example.com");
    // The exact overlap that lost a message before the lock: a status change
    // landing while a reply is being appended.
    await Promise.all([
      store.appendMessage(raced.id, "agent", "I've opened a ticket for you."),
      store.updateConversation(raced.id, { status: "ticketed", ticketId: "99999" }),
      store.appendMessage(raced.id, "visitor", "thanks!"),
    ]);
    const racedAfter = await store.getConversation(raced.id);
    check(
      "concurrent appends both survive",
      racedAfter!.messages.length === 2,
      `${racedAfter!.messages.length} of 2 messages survived`,
    );
    check("the concurrent status change survives", racedAfter!.status === "ticketed", racedAfter!.status);
    check("the concurrent ticket link survives", racedAfter!.ticketId === "99999");
  }

  // chat-store has no delete — conversations expire on their own TTL — so a
  // --kv run tidies up after itself here, directly against Redis.
  section("Cleanup");
  if (kvLive) await forgetConversations();
  else skip("KV cleanup", "nothing was written outside this process");

  console.log(
    `\n${failures ? "FAILED" : "PASSED"} — ${failures} failure${failures === 1 ? "" : "s"}` +
      (skipped ? `, ${skipped} skipped` : ""),
  );
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.stack : e);
  process.exit(1);
});
