/**
 * When a tool runs and declines, does the rest of the run know nothing
 * happened? No network, no model.
 *
 *   npx tsx scripts/declined-tools-test.ts
 *
 * A refusal reaches the model as an ordinary string, so a tool that said "Not
 * created" looked, to everything reading the run afterwards, exactly like one
 * that created something. The clearest case was in chat: the model called
 * create_support_ticket, the tool declined, the model wrote nothing more, and
 * the stand-in reply told the visitor "I've passed this to our team".
 */
export {};

process.env.STUB_MODE = "true";
process.env.JETTACHAT_LIVE = "true";
process.env.JETTACHAT_SECRET = "declined-test-secret-do-not-use-in-prod";
for (const v of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_URL"]) {
  delete process.env[v];
}

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${!ok && detail ? `\n        ${detail}` : ""}`);
}
const section = (name: string) => console.log(`\n── ${name} ──`);

type Tool = { execute: (input: Record<string, unknown>, opts?: unknown) => Promise<string> };

async function main() {
  const { toolLists } = await import("../lib/agent");
  const { chooseDelivery } = await import("../lib/chat-run");
  const { buildTools } = await import("../lib/tools");
  const store = await import("../lib/chat-store");

  section("The run's tool list");
  const trace = [{ tool: "search_knowledge_base" }, { tool: "create_support_ticket" }];
  check("with nothing declined, a tool that ran is used", toolLists(trace).toolsUsed.includes("create_support_ticket"));
  const one = toolLists(trace, ["create_support_ticket"]);
  check("a declined call is not \"used\"", one.toolsUsed.join() === "search_knowledge_base", one.toolsUsed.join());
  check("…and is listed as declined", one.toolsDeclined.join() === "create_support_ticket");
  const twice = toolLists([{ tool: "create_support_ticket" }, { tool: "create_support_ticket" }], ["create_support_ticket"]);
  check("declined once, done once (a bad email, then a good one) → used once", twice.toolsUsed.join() === "create_support_ticket", twice.toolsUsed.join());
  const mixed = toolLists([{ tool: "send_escalation", failed: true }, { tool: "request_human" }], ["request_human"]);
  check("a call that threw and a call that declined are both left out", mixed.toolsUsed.length === 0 && mixed.toolsFailed.join() === "send_escalation");

  section("What the visitor is told when the model goes quiet");
  check("ticket really opened → \"passed to our team\"", chooseDelivery("", ["create_support_ticket"]).kind === "ticket_ack");
  check("ticket declined → not that", chooseDelivery("", one.toolsUsed).kind === "fallback", chooseDelivery("", one.toolsUsed).kind);
  check("team really pinged → \"I've asked the team\"", chooseDelivery("", ["request_human"]).kind === "handoff_ack");
  check("ping declined → not that", chooseDelivery("", mixed.toolsUsed).kind === "fallback");

  section("The tools say so themselves");
  const conv = await store.createConversation({ surface: "wordpress", visitor: {} });
  await store.appendMessage(conv.id, "visitor", "I need help");
  const ctx = (channel: string, chat: Record<string, unknown> = {}) =>
    ({
      channel,
      ticket: channel === "jettachat" ? { id: conv.id, subject: "s", description: "d", status: "open", replies: [] } : null,
      account: null,
      relatedDevItems: [],
      product: "jetpackapps",
      appProduct: "unknown",
      app: "unknown",
      ...(channel === "jettachat" ? { chat: { surface: "wordpress", handoffEnabled: true, ...chat } } : {}),
    }) as never;
  const run = async (channel: string, tool: string, input: Record<string, unknown>, chat?: Record<string, unknown>) => {
    const signals = { resolutionSent: false } as { resolutionSent: boolean; declined?: string[] };
    const tools = buildTools(ctx(channel, chat), signals as never) as unknown as Record<string, Tool>;
    const text = await tools[tool].execute(input);
    return { text, declined: signals.declined ?? [] };
  };

  let r = await run("jettachat", "create_support_ticket", { email: "not an email", subject: "Sync", summary: "It stops." });
  check("a ticket refused for a bad email is declined", r.declined.join() === "create_support_ticket", `${r.declined.join()} | ${r.text.slice(0, 80)}`);

  await store.updateConversation(conv.id, { humanRequestedAt: Date.now() - 60 * 60_000, status: "open" });
  r = await run("jettachat", "request_human", { reason: "wants a person" });
  check("asking for a person again after nobody came is declined", r.declined.join() === "request_human" && /nobody was free/.test(r.text), r.text.slice(0, 90));

  await store.updateConversation(conv.id, { status: "waiting_human" });
  r = await run("jettachat", "request_human", { reason: "wants a person" });
  check("…but while the team is still being waited for, it is not: she stays quiet", r.declined.length === 0 && /already been asked/.test(r.text), r.text.slice(0, 90));

  r = await run("freshdesk", "reply_to_ticket", { body: "Hi" });
  check("a reply with no ticket to reply to is declined", r.declined.join() === "reply_to_ticket", r.text);
  r = await run("freshdesk", "add_private_note", { body: "note", status: "resolution_sent" });
  check("a note with no ticket is declined", r.declined.join() === "add_private_note", r.text);
  r = await run("freshdesk", "close_ticket", {});
  check("a close with no ticket is declined", r.declined.join() === "close_ticket", r.text);

  section("Every \"nothing happened\" result in the outcome tools is marked");
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../lib/tools/index.ts", import.meta.url), "utf8");
  // Phrases these tools use only when the action did not happen.
  const NOTHING = /return\s+(`|")(Not created|NOT filed|No active (?!ticket in this context)|This conversation has (expired|no ticket)|monday writes are off|SHADOW MODE|Recorded \(shadow mode|Already (posted|asked)|Could not reach the ticket system|Dev item \$\{[^}]+\} could not be read)/g;
  const unmarked = [...src.matchAll(NOTHING)].map((m) => src.slice(0, m.index).split("\n").length);
  check("no bare `return \"Not created…\"` and the like", unmarked.length === 0, `unmarked at lines ${unmarked.join(", ")}`);
  check("…and the marker is in use", (src.match(/return declined\(/g) ?? []).length >= 25, String((src.match(/return declined\(/g) ?? []).length));
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} FAILED` : "\nall passed");
    process.exit(failures ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
