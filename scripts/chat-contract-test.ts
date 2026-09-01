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

  // ── App attribution ──────────────────────────────────────────────
  //
  // The app is a reporting LABEL. Writing one must not look like the visitor
  // said something: `lastActivityAt` orders the inbox and drives `isStale`,
  // which is what stops someone returning weeks later with a different problem
  // from being dropped back into a thread they cannot get out of. The backfill
  // stamps every conversation at once, so a clock bump here is not a cosmetic
  // bug — it would resurrect the lot.
  section("App attribution");
  {
    const conv = await store.createConversation({
      surface: "wordpress",
      visitor: { name: "Attribution", email: "attr@example.com" },
    });
    check("a conversation with no data-app starts unattributed", conv.app === undefined);

    // A pause, so a bump would differ by milliseconds rather than landing in
    // the same one and passing by luck.
    const before = conv.lastActivityAt;
    await new Promise((r) => setTimeout(r, 5));

    await store.setConversationApp(conv.id, "vlookup");
    const after = await store.getConversation(conv.id);
    check("the app is stamped", after?.app === "vlookup");
    check("…without touching lastActivityAt", after?.lastActivityAt === before);
    // The contrast that makes the check mean something: an ordinary patch DOES
    // move the clock, and that is correct — it is what the app stamp must not
    // borrow.
    await new Promise((r) => setTimeout(r, 5));
    await store.updateConversation(conv.id, { status: "resolved" });
    check(
      "…while an ordinary patch still does",
      (await store.getConversation(conv.id))?.lastActivityAt !== before,
    );

    await store.setConversationApp(conv.id, "unknown");
    check(
      "…and 'unknown' never overwrites what was worked out",
      (await store.getConversation(conv.id))?.app === "vlookup",
    );

    const pinned = await store.createConversation({
      surface: "monday",
      visitor: { name: "Pinned", email: "pin@example.com", app: "getsign" },
    });
    check("an embed's data-app is seeded at creation", pinned.app === "getsign");
  }

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

  // The post-ticket turn. Going quiet after pushing to an existing ticket is
  // the same kind of success as going quiet after opening one, and it was the
  // fallback's most likely new false positive.
  const quietAdd = chooseDelivery("", ["add_to_ticket"]);
  check("going quiet after adding to a ticket is not a crash", quietAdd.kind === "added_ack", quietAdd.kind);
  check(
    "the add stand-in does not re-announce a ticket she already told them about",
    !/passed (this|it) to/i.test(quietAdd.text),
    quietAdd.text,
  );
  check(
    "opening a ticket outranks adding to one",
    chooseDelivery("", ["add_to_ticket", "create_support_ticket"]).kind === "ticket_ack",
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

  /*
   * One conversation, one thread.
   *
   * A ticketed chat that could still reach create_support_ticket would give the
   * customer two notification emails and the team two threads to argue over,
   * and no prompt wording reliably stops a model from using a tool it holds.
   * The swap is the guarantee, so it is asserted rather than described.
   */
  const postTicketCtx = {
    channel: "jettachat",
    ticket: { id: "conv-1", subject: "s", description: "d", status: "ticketed", replies: [] },
    account: null,
    relatedDevItems: [],
    product: "jetpackapps",
    appProduct: "unknown",
    app: "unknown",
    chat: { surface: "wordpress", handoffEnabled: true, ticketId: "12345" },
  } as never;
  const postTicketTools = Object.keys(buildTools(postTicketCtx, {} as never));
  check(
    "a ticketed chat can push to the one it has",
    postTicketTools.includes("add_to_ticket"),
    postTicketTools.join(", "),
  );
  // One ticket per ISSUE, not per conversation. She keeps create_support_ticket
  // so a genuinely separate problem gets its own thread instead of riding along
  // in a note under a subject about something else — where it is forgotten the
  // moment the first issue is resolved.
  check(
    "a ticketed chat can still open one for a separate issue",
    postTicketTools.includes("create_support_ticket"),
    postTicketTools.join(", "),
  );
  check(
    "an un-ticketed chat has no add_to_ticket to misuse",
    !chatTools.includes("add_to_ticket") && chatTools.includes("create_support_ticket"),
    chatTools.join(", "),
  );
  // Both descriptions have to name the boundary, because the tool list no
  // longer enforces it — this is the only thing standing between one ticket per
  // issue and one ticket per message.
  const postTools = buildTools(postTicketCtx, {} as never) as Record<string, { description?: string }>;
  check(
    "add_to_ticket points at the other tool for a different problem",
    /create_support_ticket/.test(postTools.add_to_ticket?.description ?? ""),
  );
  check(
    "create_support_ticket points back for the same problem",
    /add_to_ticket/.test(postTools.create_support_ticket?.description ?? ""),
  );
  // Asking for a person survives the swap: "I've been waiting two days" is
  // exactly the moment a ticketed customer needs one, and the previous
  // behaviour (silence) is what made them say it.
  check(
    "a ticketed chat can still fetch a person",
    postTicketTools.includes("request_human"),
    postTicketTools.join(", "),
  );

  /*
   * Where an update goes when the ticket may be dead.
   *
   * The widget's session never expires, so a visitor can resume a
   * weeks-old conversation whose ticket a colleague closed long ago. Freshdesk
   * does not reopen a ticket because a note arrived, so noting a closed one
   * puts the customer's message somewhere nobody is watching — while she tells
   * them it reached the team.
   *
   * The failure mode on the other side is worse and less obvious: treating an
   * unreachable Freshdesk as "closed" would open a duplicate ticket for every
   * chat update during an outage. Null must mean note.
   */
  const { routeTicketUpdate } = await import("../lib/chat-ticket");
  const HAS_EMAIL = "someone@example.com";
  check("a live ticket gets a note", routeTicketUpdate("open", HAS_EMAIL).kind === "note");
  check(
    "a ticket waiting on the customer is still live",
    routeTicketUpdate("waiting on customer", HAS_EMAIL).kind === "note",
  );
  check(
    "a ticket escalated to dev is still live",
    routeTicketUpdate("escalated to dev", HAS_EMAIL).kind === "note",
  );
  check("a resolved ticket is replaced", routeTicketUpdate("resolved", HAS_EMAIL).kind === "replace");
  check("a closed ticket is replaced", routeTicketUpdate("closed", HAS_EMAIL).kind === "replace");
  check(
    "the replacement carries the address it will reply to",
    routeTicketUpdate("closed", " someone@example.com ").kind === "replace" &&
      (routeTicketUpdate("closed", " someone@example.com ") as { email: string }).email === HAS_EMAIL,
  );
  check(
    "no address means ask, not a ticket with nowhere to reply",
    routeTicketUpdate("closed", undefined).kind === "needs_email",
  );
  check("a blank address counts as none", routeTicketUpdate("closed", "   ").kind === "needs_email");
  // The one that must never regress: an unreadable status is not a dead ticket.
  check(
    "a failed Freshdesk lookup fails OPEN to a note",
    routeTicketUpdate(null, HAS_EMAIL).kind === "note",
  );
  check(
    "…and does not become a duplicate ticket even with no address",
    routeTicketUpdate(null, undefined).kind === "note",
  );

  /*
   * The idle resume window.
   *
   * The visitor's claim on a conversation never expires by itself — the token
   * is an unstamped HMAC and the id sits in the embedding page's localStorage —
   * so this comparison is the only thing that stops someone returning weeks
   * later and landing in a thread whose framing they cannot escape.
   */
  const { isStale } = await import("../lib/chat-store");
  const ago = (ms: number) =>
    ({ lastActivityAt: new Date(Date.now() - ms).toISOString() }) as never;
  const HOUR = 3_600_000;
  check("a conversation from a minute ago resumes", !isStale(ago(60_000), 24));
  check("a conversation from this morning resumes", !isStale(ago(8 * HOUR), 24));
  check("just inside the window resumes", !isStale(ago(23.5 * HOUR), 24));
  check("yesterday's conversation does not", isStale(ago(25 * HOUR), 24));
  check("last month's certainly does not", isStale(ago(30 * 24 * HOUR), 24));
  check("the window is the setting, not a constant", isStale(ago(2 * HOUR), 1));
  // A corrupt timestamp is not an old conversation. Discarding one that may be
  // seconds old is the worse failure, so this fails open to resuming.
  check(
    "an unparseable timestamp resumes rather than being discarded",
    !isStale({ lastActivityAt: "not a date" } as never, 24),
  );

  // The prompt has to swap with the tools. A post-ticket prompt still telling
  // her to "CALL create_support_ticket" is how she ends up describing an action
  // she cannot take.
  const { buildSystemPrompt: buildPrompt } = await import("../lib/system-prompt");
  const postTicketPrompt = await buildPrompt(postTicketCtx);
  check(
    "the post-ticket prompt does not order a tool she has not got",
    !postTicketPrompt.includes("CALL create_support_ticket"),
  );
  check("the post-ticket prompt tells her to push updates", postTicketPrompt.includes("add_to_ticket"));
  // "when in doubt, push it" was pushing "ok 👍" onto the ticket.
  check(
    "…but not a message that carries no information",
    /carrying no information is not a\s+doubt/i.test(postTicketPrompt),
  );
  check(
    "the post-ticket prompt keeps the ticket number internal",
    /never say the number to the customer/i.test(postTicketPrompt),
  );

  /*
   * The rules the first judged run bought, pinned so a prompt refactor cannot
   * quietly drop them. Each of these exists because glm-5.2 did the thing the
   * bullet now forbids, in a real run, against a real ticket.
   */
  check(
    "…and says how to refuse the number without lying about having it",
    /cannot pass\s+reference numbers on in chat/i.test(postTicketPrompt),
  );
  check(
    "the post-ticket prompt denies her a close she cannot do",
    /CANNOT CLOSE, CANCEL OR DELETE A TICKET/.test(postTicketPrompt),
  );
  // "I've closed this out so nobody picks it up unnecessarily" — said with no
  // note pushed, so the team kept the fixed bug in their queue.
  check(
    "…and names add_to_ticket as what to do instead",
    /resolved itself, no longer\s+needs work/i.test(postTicketPrompt),
  );

  // The same context minus the ticket, so the two prompts differ in exactly the
  // one field that is supposed to swap them.
  /*
   * Dev board writes are off this channel, and the PROMPT has to move with the
   * toolset. A judged run called create_dev_item six times in ten chats, twice
   * for a bare "ok 👍" — with MONDAY_ALLOW_WRITES armed those are real board
   * items and real Slack pings, filed from an endpoint any visitor can reach.
   * Both halves are checked here because getting
   * only one of them right is worse than neither: a prompt still ordering a tool
   * that is gone makes her DESCRIBE filing the bug, and the customer is told
   * engineering has it.
   */
  const ticketChannelTools = Object.keys(
    buildTools({ ...(postTicketCtx as unknown as Record<string, unknown>), channel: "freshdesk", chat: undefined } as never, {} as never),
  );
  for (const t of ["create_dev_item"]) {
    check(`${t} is not offered on chat`, !postTicketTools.includes(t));
    check(`…but is still there off chat`, ticketChannelTools.includes(t));
  }
  // The reads stay — knowing a bug is tracked changes the answer.
  for (const t of ["search_dev_board", "read_dev_item_comments"]) {
    check(`${t} is still offered on chat`, postTicketTools.includes(t));
  }

  const preTicketPrompt = await buildPrompt({
    ...(postTicketCtx as unknown as Record<string, unknown>),
    chat: { surface: "wordpress", handoffEnabled: true },
  } as never);
  // Four of ten runs searched, found nothing, asked questions and opened no
  // ticket — twice filing a dev item and a Slack escalation instead, which the
  // customer cannot see and cannot be replied to.
  check(
    "the pre-ticket prompt calls an ask-only turn a failed turn",
    /only asked questions is a failed turn/i.test(preTicketPrompt),
  );
  check(
    "…and says a dev item is not a ticket",
    /NOT a ticket/.test(preTicketPrompt) && /invisible to the\s+customer/i.test(preTicketPrompt),
  );

  for (const [label, pr] of [["pre-ticket", preTicketPrompt], ["post-ticket", postTicketPrompt]] as const) {
    check(
      `the ${label} prompt never orders a dev-board write`,
      !/create_dev_item/.test(pr),
      "the prompt still names a tool this channel does not have",
    );
    check(
      `the ${label} prompt says she cannot file on the board`,
      /cannot FILE anything on the Dev board/.test(pr),
    );
    /*
     * …and that the ban stops at the board.
     *
     * The first version of that bullet said "there is no tool here that does"
     * and "do not say you have logged, filed, raised or escalated anything to
     * engineering". Both false — send_escalation is ungated on this channel,
     * and create_support_ticket/add_to_ticket reach the team too — so it
     * contradicted the post-ticket rule telling her to push updates and say so
     * plainly. She went quiet instead: the run after that change stopped
     * pushing the one detail post-ticket exists to carry.
     */
    check(
      `the ${label} prompt still names what DOES reach the team`,
      /prohibition is about the BOARD/.test(pr) &&
        /send_escalation tells the team directly/.test(pr),
    );
    check(
      `the ${label} prompt does not forbid saying the team has it`,
      !/do not say you have logged, filed, raised or escalated/i.test(pr),
    );
    // The placeholder must actually be substituted, not shipped raw.
    check(`the ${label} prompt has no unreplaced placeholder`, !pr.includes("{{"));
  }

  /*
   * The invariant that the wholesale swap dropped.
   *
   * TICKET_NONE_YET has always carried "never tell a customer a ticket exists
   * unless you called create_support_ticket in THIS turn". TICKET_ALREADY_OPEN
   * replaces that block entirely, so for the whole life of the post-ticket state
   * the guarantee was simply gone — in the state where a fabricated SECOND
   * ticket is possible. post-ticket-separate-issue then did exactly that: told
   * the customer a ticket had been opened for their double charge, with one
   * create_support_ticket call in the whole conversation. Anything that must
   * hold in both states has to be asserted in both.
   */
  for (const [label, pr] of [["pre-ticket", preTicketPrompt], ["post-ticket", postTicketPrompt]] as const) {
    check(
      `the ${label} prompt forbids announcing a ticket she did not open`,
      /unless you called\s+create_support_ticket in THIS turn/i.test(pr),
    );
  }


  // The worst single output of the run: an internal status report, complete
  // with board URL and ticket number, written into the customer's chat.
  for (const [label, p] of [["pre-ticket", preTicketPrompt], ["post-ticket", postTicketPrompt]] as const) {
    check(
      `the ${label} prompt forbids a report about the customer`,
      /NEVER A REPORT ABOUT THEM/.test(p),
    );
    check(
      `the ${label} prompt requires every turn to end with a message`,
      /EVERY turn ends with a message to them/.test(p),
    );
  }

  /*
   * ── The ticket sync mark ────────────────────────────────────────
   *
   * `lastTicketSyncAt` is the seam between what Freshdesk already has and what
   * only Redis has. Everything the post-ticket state is for runs across it, and
   * every way of getting it wrong is silent: too early and the team is sent the
   * transcript twice, too late and the message that mattered is in neither the
   * ticket nor any delta. Nothing upstream notices either, because the note
   * posts successfully in both cases.
   */
  section("The ticket sync mark");
  /*
   * Two things this section has to do to be honest about the store.
   *
   * `tick` puts real milliseconds between appends. Timestamps are ISO strings
   * at millisecond resolution and the comparison is strictly-greater, so two
   * writes inside the same millisecond are indistinguishable to it — which
   * in-memory they routinely are, and over HTTP they are not.
   *
   * `snap` deep-copies. The in-memory fallback returns the SAME object on every
   * read (the reason the lock test below needs real KV), so a "snapshot" taken
   * from it keeps growing as messages arrive. Against Redis every read is a
   * fresh deserialize, and a snapshot really is frozen — which is the situation
   * openTicketForConversation is actually in.
   */
  const tick = () => new Promise((r) => setTimeout(r, 2));
  const snap = <T>(c: T): T => structuredClone(c);

  const marked = await newConv("Mark", "mark@example.com");
  const first = await store.appendMessage(marked.id, "visitor", "my board is blank");
  await tick();
  await store.updateConversation(marked.id, { status: "ticketed", ticketId: "50001" });
  const afterTicket = (await store.getConversation(marked.id))!;
  check("ticketing stamps a sync mark", !!afterTicket.lastTicketSyncAt, afterTicket.lastTicketSyncAt);
  check(
    "the message the ticket was opened FOR is not re-sent as a delta",
    !store
      .messagesSince(afterTicket, afterTicket.lastTicketSyncAt)
      .some((m) => m.id === first!.id),
  );
  await tick();
  const later = await store.appendMessage(marked.id, "visitor", "it only happens in Safari");
  const withLater = (await store.getConversation(marked.id))!;
  check(
    "…but what they say afterwards is",
    store.messagesSince(withLater, afterTicket.lastTicketSyncAt).some((m) => m.id === later!.id),
  );

  /*
   * The boundary itself. The mark is a message's own timestamp, so the message
   * AT the mark has already been sent and must not go again — while the next
   * one must. An off-by-one here duplicates a customer's words or drops them,
   * and both look like a working note.
   */
  await store.updateConversation(marked.id, { lastTicketSyncAt: later!.createdAt });
  const rebased = (await store.getConversation(marked.id))!;
  check(
    "a message exactly AT the mark is treated as already sent",
    !store.messagesSince(rebased, rebased.lastTicketSyncAt).some((m) => m.id === later!.id),
  );
  check(
    "a second push with nothing new to say carries nothing",
    store.messagesSince(rebased, rebased.lastTicketSyncAt).length === 0,
    `${store.messagesSince(rebased, rebased.lastTicketSyncAt).length} messages would be re-sent`,
  );

  /*
   * The gap this section exists for.
   *
   * `openTicketForConversation` receives a SNAPSHOT and then talks to
   * Freshdesk — a create that uploads the visitor's screenshots as multipart
   * and takes as long as that takes. A visitor typing during that window lands
   * in neither place: the ticket's transcript was built from the snapshot, and
   * a mark stamped at patch time is already past them.
   *
   * add_to_ticket states the rule this must obey — "the last message we
   * actually sent rather than 'now': a message that landed while the note was
   * in flight belongs to the next push, not to a gap." The create path owes
   * the same guarantee.
   */
  const { openTicketForConversation } = await import("../lib/chat-ticket");
  const flight = await newConv("Inflight", "inflight@example.com");
  await store.appendMessage(flight.id, "visitor", "documents are stuck generating");
  // Exactly what openTicketForConversation is handed, and builds the ticket
  // transcript from.
  const snapshot = snap((await store.getConversation(flight.id))!);
  // …and what the visitor adds while Freshdesk is still uploading. Freshdesk is
  // stubbed here, so this stands in for a call that really does take seconds
  // when there are screenshots on it.
  await tick();
  const inflight = await store.appendMessage(flight.id, "visitor", "reinstalling changed nothing");
  check(
    "the in-flight message is not in the ticket's own transcript",
    !snapshot.messages.some((m) => m.id === inflight!.id),
  );

  const opened = await openTicketForConversation(snapshot, {
    email: "inflight@example.com",
    subject: "Documents stuck generating",
    summary: "Contract test.",
  });
  check(
    "the mark describes the transcript that was sent, not the clock",
    !!opened.syncMark && opened.syncMark === snapshot.messages.at(-1)!.createdAt,
    opened.syncMark ?? "no mark returned",
  );

  // Applied the way all three callers apply it.
  await store.updateConversation(flight.id, {
    status: "ticketed",
    ticketId: opened.id,
    lastTicketSyncAt: opened.syncMark,
  });
  const handed = (await store.getConversation(flight.id))!;
  check(
    "a message sent while the ticket was being created survives into the first delta",
    store.messagesSince(handed, handed.lastTicketSyncAt).some((m) => m.id === inflight!.id),
    "it is in neither the ticket transcript nor any delta — the team never sees it",
  );

  /*
   * Files ride the same mark as the words.
   *
   * add_to_ticket attaches whatever is on the messages in its delta, so the
   * mark is the only thing stopping a screenshot being uploaded to the same
   * ticket on every later push. Freshdesk does not de-duplicate — the agent
   * gets the same file four times and has to work out whether they are
   * different.
   */
  const shot = {
    id: "att-1",
    name: "blank-board.png",
    contentType: "image/png",
    size: 12_345,
    pathname: "chat/att-1/blank-board.png",
  };
  const filed = await newConv("Filed", "filed@example.com");
  await store.updateConversation(filed.id, { status: "ticketed", ticketId: "50003" });
  await tick();
  const withShot = await store.appendMessage(filed.id, "visitor", "here's what I see", {
    attachments: [shot],
  });
  const beforePush = (await store.getConversation(filed.id))!;
  check(
    "a newly sent file is in the delta waiting to go",
    store
      .messagesSince(beforePush, beforePush.lastTicketSyncAt)
      .some((m) => m.attachments?.length),
  );
  await store.updateConversation(filed.id, { lastTicketSyncAt: withShot!.createdAt });
  const afterPush = (await store.getConversation(filed.id))!;
  await tick();
  await store.appendMessage(filed.id, "visitor", "any update?");
  const nextDelta = store.messagesSince(
    (await store.getConversation(filed.id))!,
    afterPush.lastTicketSyncAt,
  );
  check(
    "…and is not attached a second time on the next push",
    nextDelta.length === 1 && !nextDelta.some((m) => m.attachments?.length),
    `${nextDelta.filter((m) => m.attachments?.length).length} already-sent file(s) would re-upload`,
  );

  /*
   * A second ticket re-bases everything.
   *
   * It carries the WHOLE transcript, so nothing is outstanding against it the
   * moment it opens. Leaving the old mark in place would make the next push
   * re-send, to the new ticket, every message the new ticket already contains.
   */
  const second = await newConv("Second", "second@example.com");
  await store.appendMessage(second.id, "visitor", "prefix will not stick");
  await store.updateConversation(second.id, { status: "ticketed", ticketId: "60001" });
  await tick();
  await store.appendMessage(second.id, "visitor", "different thing — we were double charged");
  const beforeSecond = snap((await store.getConversation(second.id))!);
  const reopened = await openTicketForConversation(beforeSecond, {
    email: "second@example.com",
    subject: "Duplicate charge",
    summary: "Contract test.",
  });
  await store.updateConversation(second.id, {
    ticketId: reopened.id,
    previousTicketIds: [...(beforeSecond.previousTicketIds ?? []), beforeSecond.ticketId!],
    ticketedAt: new Date().toISOString(),
    lastTicketSyncAt: reopened.syncMark,
  });
  const twoTickets = (await store.getConversation(second.id))!;
  check(
    "the superseded ticket is kept, not overwritten",
    twoTickets.previousTicketIds?.includes("60001") === true && twoTickets.ticketId === reopened.id,
    `active ${twoTickets.ticketId}, previous ${JSON.stringify(twoTickets.previousTicketIds)}`,
  );
  check(
    "the new ticket starts with nothing outstanding against it",
    store.messagesSince(twoTickets, twoTickets.lastTicketSyncAt).length === 0,
    `${store.messagesSince(twoTickets, twoTickets.lastTicketSyncAt).length} messages would re-send to a ticket that has them`,
  );

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

  /*
   * The same slug, arriving three ways, must not be described three times the
   * same. A support page opened from a monday button is a PUBLIC URL: its
   * parameters are typed by whoever holds the link, and the slug is the field
   * Jetta acts on — trial and discount requests go against it without asking.
   * A verified session token, or the app view itself, earns that. A link does
   * not.
   */
  const linkPrompt = await buildSystemPrompt(
    promptCtx({ surface: "wordpress", mondayAccountSlug: "someone-elses-team", handoffEnabled: true }),
  );
  check(
    "a slug from a support LINK is marked unproven",
    /CLAIMED/.test(linkPrompt) && /NOT proven/i.test(linkPrompt),
  );
  check(
    "…and does not carry the do-not-ask licence",
    !/do NOT ask the customer for their monday URL/.test(linkPrompt),
    "an unverified link would be able to move somebody else's subscription",
  );
  const verifiedPrompt = await buildSystemPrompt(
    promptCtx({
      surface: "wordpress",
      mondayAccountSlug: "acme",
      mondayAccountVerified: true,
      handoffEnabled: true,
    }),
  );
  check(
    "…while a VERIFIED token does, on the very same surface",
    /VERIFIED/.test(verifiedPrompt) &&
      /do NOT ask the customer for their monday URL/.test(verifiedPrompt),
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
