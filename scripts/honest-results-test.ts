/**
 * Does Jetta say what actually happened — when a write was switched off, when
 * a lookup failed, when a post landed somewhere else, when a tool threw?
 *
 *   npx tsx scripts/honest-results-test.ts
 *
 * No network (fetch is replaced), no model. Each case here used to come back
 * as an ordinary success, and the next thing in the chain repeated it: to the
 * customer ("your subscription is cancelled"), to Slack (a green tick), to the
 * developer ("the context was added"), or to the run log (escalated: true).
 */
export {};

// Before ANY import: lib/config.ts snapshots process.env on first load.
process.env.STUB_MODE = "true";
process.env.FASTSPRING_LIVE = "true";
process.env.FASTSPRING_API_USERNAME_VLOOKUP = "test-user";
process.env.FASTSPRING_API_PASSWORD_VLOOKUP = "test-pass";
process.env.MONDAY_LIVE = "true";
process.env.MONDAY_API_TOKEN = "test-token";
process.env.MONDAY_BOARD_ID_JETPACKAPPS = "111";
process.env.MONDAY_COMPLIANCE_BOARD_ID = "222";
for (const v of [
  "FASTSPRING_ALLOW_WRITES",
  "MONDAY_ALLOW_WRITES",
  "FASTSPRING_API_USERNAME_TRACKMY",
  "FASTSPRING_API_PASSWORD_TRACKMY",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_URL",
  "OPENROUTER_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "ANTHROPIC_API_KEY",
]) {
  delete process.env[v];
}

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${!ok && detail ? `\n        ${detail}` : ""}`);
}
const section = (name: string) => console.log(`\n── ${name} ──`);

// ── fetch, replaced ──
type Reply = { status?: number; json?: unknown; throws?: boolean };
let handler: (url: string, body: string) => Reply = () => ({ status: 500, json: {} });
const calls: { url: string; body: string }[] = [];
globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
  const url = String(input);
  const body = typeof init?.body === "string" ? init.body : "";
  calls.push({ url, body });
  const r = handler(url, body);
  if (r.throws) throw new TypeError("fetch failed");
  return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

type Tool = { execute: (input: Record<string, unknown>, opts?: unknown) => Promise<string> };

async function main() {
  const { config } = await import("../lib/config");
  const fastspring = await import("../lib/tools/fastspring");
  const monday = await import("../lib/tools/monday");
  const { buildTools, FASTSPRING_LOOKUP_FAILED } = await import("../lib/tools");
  const { toolLists } = await import("../lib/agent");
  const { buildSystemPrompt } = await import("../lib/system-prompt");
  const cfg = config as unknown as { fastspring: { allowWrites: boolean; live: boolean }; monday: { allowWrites: boolean } };

  const ctx = (extra: Record<string, unknown> = {}) =>
    ({
      channel: "freshdesk",
      ticket: { id: "14600", subject: "s", description: "d", status: "open", replies: [], requesterEmail: "pat@example.com" },
      account: { found: true, subscriptionId: "sub_1", invoices: [] },
      relatedDevItems: [],
      product: "jetpackapps",
      appProduct: "vlookup",
      app: "vlookup",
      ...extra,
    }) as never;
  const tools = (extra?: Record<string, unknown>) => buildTools(ctx(extra), {} as never) as unknown as Record<string, Tool>;

  section("FastSpring: a write that did not happen says so");
  calls.length = 0;
  const cancel = await fastspring.cancelSubscription("sub_1", "vlookup");
  check("writes off → cancel reports nothing done", cancel.done === false && cancel.reason === "writes_off", JSON.stringify(cancel));
  const discount = await fastspring.applyDiscount("sub_1", "RETAIN20", "vlookup");
  check("writes off → discount reports nothing done", discount.done === false && discount.reason === "writes_off", JSON.stringify(discount));
  check("…and FastSpring was never called", calls.length === 0, `${calls.length} calls`);
  const noStore = await fastspring.cancelSubscription("sub_1", "getsign");
  check("no store for the app → not connected", noStore.done === false && noStore.reason === "not_connected", JSON.stringify(noStore));

  const cancelOut = await tools().cancel_subscription.execute({});
  check(
    "the cancel tool tells the model nothing was cancelled",
    /NOTHING was cancelled/.test(cancelOut) && !cancelOut.startsWith("Subscription cancelled"),
    cancelOut,
  );
  const discountOut = await tools().apply_discount.execute({});
  check("the discount tool tells the model no discount was applied", /NO discount was applied/.test(discountOut) && !/^Discount applied/.test(discountOut), discountOut);

  cfg.fastspring.allowWrites = true;
  handler = () => ({ status: 200, json: {} });
  const real = await fastspring.cancelSubscription("sub_1", "vlookup");
  check("writes on → a real cancel is reported as done", real.done === true, JSON.stringify(real));
  const realOut = await tools().cancel_subscription.execute({});
  check("…and the tool's success wording is unchanged (self-review keys on it)", realOut.startsWith("Subscription cancelled."), realOut);
  cfg.fastspring.allowWrites = false;

  section("FastSpring: a lookup that failed is not \"no account\"");
  handler = () => ({ status: 503, json: { error: "unavailable" } });
  let acct = await fastspring.getFastSpringAccount("pat@example.com", "vlookup");
  check("a 503 is a failed lookup", acct.found === false && acct.lookupFailed === true, JSON.stringify(acct));
  handler = () => ({ status: 429, json: {} });
  acct = await fastspring.getFastSpringAccount("pat@example.com", "vlookup");
  check("a rate limit is a failed lookup", acct.lookupFailed === true);
  handler = () => ({ throws: true });
  acct = await fastspring.getFastSpringAccount("pat@example.com", "vlookup");
  check("no response at all is a failed lookup", acct.lookupFailed === true);
  handler = () => ({ status: 401, json: {} });
  acct = await fastspring.getFastSpringAccount("pat@example.com", "vlookup");
  check("rejected credentials are a failed lookup", acct.lookupFailed === true);
  handler = () => ({ status: 200, json: { accounts: [] } });
  acct = await fastspring.getFastSpringAccount("pat@example.com", "vlookup");
  check("an empty list is a real \"not found\"", acct.found === false && !acct.lookupFailed, JSON.stringify(acct));
  handler = () => ({ status: 400, json: { result: "error", error: { email: "Not found" } } });
  acct = await fastspring.getFastSpringAccount("pat@example.com", "vlookup");
  check("a 400 \"not found\" answer is a real \"not found\"", acct.found === false && !acct.lookupFailed, JSON.stringify(acct));
  handler = (url) =>
    url.includes("/accounts?email=") ? { status: 200, json: { accounts: ["acc_1"] } } : { status: 502, json: {} };
  acct = await fastspring.getFastSpringAccount("pat@example.com", "vlookup");
  check("the account object failing to load is a failed lookup too", acct.lookupFailed === true, JSON.stringify(acct));

  handler = () => ({ status: 503, json: {} });
  const lookupOut = await tools().get_fastspring_account.execute({});
  check("the lookup tool tells the model the lookup FAILED", lookupOut === FASTSPRING_LOOKUP_FAILED, lookupOut.slice(0, 120));
  let threw = false;
  await fastspring.findAccountAcrossStores("pat@example.com").catch(() => (threw = true));
  check("the cross-store lookup (Slack, console assistant) throws rather than say \"none\"", threw);
  handler = () => ({ status: 200, json: { accounts: [] } });
  check("…and still returns null when every store answered \"none\"", (await fastspring.findAccountAcrossStores("pat@example.com")) === null);
  const failedPrompt = await buildSystemPrompt(ctx({ account: { found: false, lookupFailed: true, invoices: [] } }));
  check("the prompt says the billing lookup FAILED, not that there is no account", /FastSpring lookup FAILED/.test(failedPrompt) && !/no FastSpring account found/.test(failedPrompt));
  const missPrompt = await buildSystemPrompt(ctx({ account: { found: false, invoices: [] } }));
  check("a real miss still reads as no account", /no FastSpring account found/.test(missPrompt));

  section("monday: nothing filed is reported as nothing filed");
  calls.length = 0;
  const input = {
    title: "Sync broken",
    product: "jetpackapps" as const,
    accountUrl: "https://acme.monday.com",
    errorDescription: "the sync stops",
    reproSteps: "open the board",
    freshdeskTicketUrl: "https://x.freshdesk.com/a/tickets/14600",
  };
  const unfiled = await monday.createDevItem(input);
  check(
    "writes off → no id, no URL, and a reason",
    unfiled.notWritten === "writes_off" && unfiled.id === "" && unfiled.url === "",
    JSON.stringify(unfiled),
  );
  const unfiledCompliance = await monday.createComplianceItem({ ...input, app: "vlookup", summary: "DPA please" } as never);
  check("the same for a compliance request", unfiledCompliance.notWritten === "writes_off" && unfiledCompliance.url === "", JSON.stringify(unfiledCompliance));
  check("…and monday was never called", calls.length === 0, `${calls.length} calls`);
  const complianceOut = await tools().send_to_compliance.execute({ company: "Acme", request: "DPA", summary: "They need a DPA signed." });
  check(
    "the compliance tool tells the model nothing was filed",
    /^NOT filed/.test(complianceOut) && !/Filed compliance request/.test(complianceOut) && !/9900/.test(complianceOut),
    complianceOut,
  );

  section("monday: an item whose context did not post says so");
  cfg.monday.allowWrites = true;
  let updateAttempts = 0;
  handler = (_url, body) => {
    if (body.includes("create_update")) {
      updateAttempts++;
      return { status: 200, json: { errors: [{ message: "Internal server error" }] } };
    }
    if (body.includes("create_item")) return { status: 200, json: { data: { create_item: { id: "555", name: "Sync broken" } } } };
    return { status: 200, json: { data: { boards: [{ columns: [], groups: [], items_page: { cursor: null, items: [] } }] } } };
  };
  const lost = await monday.createDevItem(input);
  check("the item is created", lost.id === "555" && !lost.notWritten, JSON.stringify(lost));
  check("…the context post is retried once, then reported as failed", updateAttempts === 2 && lost.contextPosted === false, `attempts ${updateAttempts}, contextPosted ${lost.contextPosted}`);
  handler = (_url, body) => {
    if (body.includes("create_update")) return { status: 200, json: { data: { create_update: { id: "900" } } } };
    if (body.includes("create_item")) return { status: 200, json: { data: { create_item: { id: "556", name: "Sync broken" } } } };
    return { status: 200, json: { data: { boards: [{ columns: [], groups: [], items_page: { cursor: null, items: [] } }] } } };
  };
  const fine = await monday.createDevItem(input);
  check("a normal filing reports its context as posted", fine.id === "556" && fine.contextPosted === true, JSON.stringify(fine));

  section("monday: a reply that could not go in the thread says so");
  handler = (_url, body) => {
    const vars = (JSON.parse(body) as { variables?: { parent?: string } }).variables;
    if (vars?.parent) return { status: 200, json: { errors: [{ message: "Complexity budget exhausted" }] } };
    return { status: 200, json: { data: { create_update: { id: "901" } } } };
  };
  const fallback = await monday.postJettaComment("555", "New from the customer", { parentUpdateId: "100" });
  check("the comment still posts, flagged as NOT threaded", fallback?.id === "901" && fallback.threaded === false, JSON.stringify(fallback));
  handler = () => ({ status: 200, json: { data: { create_update: { id: "902" } } } });
  const threaded = await monday.postJettaComment("555", "New from the customer", { parentUpdateId: "100" });
  check("a reply that lands in the thread is flagged as threaded", threaded?.threaded === true, JSON.stringify(threaded));
  const top = await monday.postJettaComment("555", "A chase");
  check("a top-level post is not \"threaded\"", top?.threaded === false);
  cfg.monday.allowWrites = false;

  section("A tool that threw did not happen");
  const lists = toolLists([
    { tool: "search_knowledge_base" },
    { tool: "send_escalation", failed: true },
    { tool: "create_support_ticket", failed: true },
    { tool: "add_private_note" },
  ]);
  check("failed calls are left out of toolsUsed", lists.toolsUsed.join() === "search_knowledge_base,add_private_note", lists.toolsUsed.join());
  check("…and listed in toolsFailed", lists.toolsFailed.join() === "send_escalation,create_support_ticket", lists.toolsFailed.join());
  const { chooseDelivery } = await import("../lib/chat-run");
  check(
    "so a chat whose ticket tool threw does not tell the visitor a ticket was opened",
    chooseDelivery("", lists.toolsUsed).kind === "fallback",
    chooseDelivery("", lists.toolsUsed).kind,
  );
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
