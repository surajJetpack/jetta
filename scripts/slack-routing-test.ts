/**
 * Which Slack channel does each notification go to?
 *
 * Four unrelated kinds of message used to share one channel, three of them
 * only because their own setting was never filled in — a fallback nobody
 * noticed. This pins the routing down so the next unset variable is a failing
 * check rather than a channel that quietly fills up.
 *
 *   npx tsx scripts/slack-routing-test.ts
 */
// Stubbed on purpose: postMessage logs the channel instead of sending, which
// is exactly what this asserts on. SLACK_LIVE stays unset — setting it would
// make these checks post into the real workspace.
// Marks this file a module. Without it, `tsc --noEmit` treats every script with
// no top-level import as one shared global scope, and the `check` helper each
// test script defines collides with the next one's — three errors that had
// nothing to do with this file's own correctness.
export {};

process.env.STUB_MODE = "true";
delete process.env.SLACK_LIVE;
process.env.SLACK_ESCALATION_CHANNEL = "#jetta-escalations";

// lib/config snapshots the environment on first import, so the
// channels-not-configured case cannot be simulated in the same process — it
// runs as a child with different env. Trying to re-import a "fresh" copy
// silently reads the cached config and passes for the wrong reason.
const CONFIGURED = process.argv[2] !== "unset";
if (CONFIGURED) {
  process.env.SLACK_CHAT_CHANNEL = "#jetta-chat";
  process.env.SLACK_OPS_CHANNEL = "#jetta-ops";
} else {
  delete process.env.SLACK_CHAT_CHANNEL;
  delete process.env.SLACK_OPS_CHANNEL;
}

let failures = 0;
const sent: string[] = [];
const realLog = console.log;
console.log = (...args: unknown[]) => {
  const line = args.map(String).join(" ");
  if (line.startsWith("[stub] slack →")) sent.push(line.split("\n")[0]!.replace("[stub] slack → ", ""));
  else realLog(...args);
};

function check(name: string, pass: boolean, detail?: string) {
  realLog(`${pass ? "  ok  " : "FAIL  "}${name}${!pass && detail ? ` — ${detail}` : ""}`);
  if (!pass) failures++;
}

async function main() {
  const slack = await import("../lib/tools/slack");

  sent.length = 0;
  await slack.sendEscalation({
    freshdeskTicketUrl: "https://x/1",
    userAccountUrl: "",
    headline: "Signed docs stop syncing",
    summary: "s",
    alreadyTried: "a",
    question: "q",
  });
  check("dev escalation → escalations", sent.every((c) => c.startsWith("#jetta-escalations")), sent.join(", "));

  sent.length = 0;
  await slack.notifyChatHandoff({
    conversationId: "abc",
    visitor: "Someone",
    reason: "wants a person",
    lastMessage: "hello?",
    consoleUrl: "https://console",
  });
  check("visitor waiting → chat", sent.every((c) => c.startsWith("#jetta-chat")), sent.join(", "));

  sent.length = 0;
  await slack.requestMonetApproval({
    id: "req_1",
    action: "trial",
    app: "vlookup",
    accountSlug: "acme",
    summary: "14-day trial",
    ticketUrl: "https://x/1",
  });
  check("trial/discount approval → ops", sent.every((c) => c.startsWith("#jetta-ops")), sent.join(", "));

  sent.length = 0;
  await slack.notifyKbSync("KB sync done", ["3 articles updated"]);
  check("daily KB report → ops", sent.every((c) => c.startsWith("#jetta-ops")), sent.join(", "));

  // The point of the split: nothing but dev work reaches the escalation channel.
  check("nothing else leaked into escalations", !sent.some((c) => c.startsWith("#jetta-escalations")), sent.join(", "));
}

/**
 * Before the channels exist, everything must still arrive SOMEWHERE. A
 * notification that vanishes because a variable is unset is the one failure
 * this change could otherwise introduce.
 */
async function fallbackMode() {
  const slack = await import("../lib/tools/slack");
  sent.length = 0;
  await slack.notifyChatHandoff({
    conversationId: "abc",
    visitor: "Someone",
    reason: "wants a person",
    lastMessage: "hello?",
    consoleUrl: "https://console",
  });
  await slack.notifyKbSync("KB sync done", ["3 articles updated"]);
  check(
    "channels unset → falls back, nothing dropped",
    sent.length >= 2 && sent.every((c) => c.startsWith("#jetta-escalations")),
    sent.join(", "),
  );
}

void (CONFIGURED ? main() : fallbackMode()).then(async () => {
  console.log = realLog;
  if (CONFIGURED) {
    // Same file, fresh process, no channels configured.
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync("npx", ["tsx", "scripts/slack-routing-test.ts", "unset"], { encoding: "utf8" });
    process.stdout.write((r.stdout ?? "").replace(/\nRouting is correct\n|\n\d+ failing\n/, ""));
    if (r.status !== 0) failures++;
  }
  console.log(failures ? `\n${failures} failing\n` : "\nRouting is correct\n");
  process.exit(failures ? 1 : 0);
});
