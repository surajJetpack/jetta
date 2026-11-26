/**
 * Can a colleague ask Jetta about the compliance board, and does the team see
 * a request's link when she files one?
 *
 *   npx tsx scripts/compliance-board-read-test.ts
 *
 * No network (fetch is replaced), no model. Before this, her read-only tools
 * covered the two dev boards only, so a pasted Security Questionnaires link
 * got "I can't open that"; and a filed request's link lived only in a
 * Freshdesk private note.
 */
export {};

// Before ANY import: lib/config.ts snapshots process.env on first load.
process.env.STUB_MODE = "true";
process.env.MONDAY_LIVE = "true";
process.env.MONDAY_ALLOW_WRITES = "true";
process.env.MONDAY_API_TOKEN = "test-token";
process.env.MONDAY_ACCOUNT_URL = "https://acme.monday.com";
process.env.MONDAY_BOARD_ID_JETPACKAPPS = "111";
process.env.MONDAY_BOARD_ID_COMPLIANCE = "222";
process.env.SLACK_ESCALATION_CHANNEL = "#esc";
for (const v of ["SLACK_LIVE", "KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_URL"]) {
  delete process.env[v];
}

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${!ok && detail ? `\n        ${detail}` : ""}`);
}
const section = (name: string) => console.log(`\n── ${name} ──`);

type Reply = { status?: number; json?: unknown; throws?: boolean };
let handler: (body: string) => Reply = () => ({ status: 500, json: {} });
globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
  const r = handler(typeof init?.body === "string" ? init.body : "");
  if (r.throws) throw new TypeError("fetch failed");
  return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

// Stubbed Slack posts are printed; keep them to read back.
const printed: string[] = [];
const realLog = console.log;
console.log = (...args: unknown[]) => {
  printed.push(args.map(String).join(" "));
  realLog(...args);
};

type Tool = { execute: (input: Record<string, unknown>, opts?: unknown) => Promise<string> };

const ROWS = [
  {
    id: "9001",
    name: "Acme — DPA",
    group: { title: "In Process" },
    column_values: [
      { text: "Pending", type: "status", column: { title: "Status" } },
      { text: "Mark Shaw", type: "people", column: { title: "Person" } },
      { text: "#14700 - https://x.freshdesk.com/a/tickets/14700", type: "link", column: { title: "Ticket" } },
    ],
    updates: [],
  },
  {
    id: "9002",
    name: "Filed by hand",
    group: { title: "In Process" },
    column_values: [{ text: "Stuck", type: "status", column: { title: "Status" } }],
    updates: [],
  },
];

const board = (rows: unknown[]): Reply => ({
  json: {
    data: {
      boards: [
        {
          columns: [],
          groups: [
            { id: "topics", title: "In Process", items_page: { cursor: null, items: rows } },
            { id: "done", title: "Done", items_page: { cursor: null, items: [] } },
          ],
        },
      ],
    },
  },
});

async function main() {
  const { readOnlyTools } = await import("../lib/assistant-tools");
  const { buildTools } = await import("../lib/tools");
  const { buildSystemPrompt } = await import("../lib/system-prompt");
  const read = readOnlyTools() as unknown as Record<string, Tool>;

  section("A colleague asks what is on the compliance board");
  handler = () => board(ROWS);
  const listed = JSON.parse(await read.list_compliance_requests.execute({})) as {
    board: string;
    open: number;
    items: { id: string; title: string; status: string; url: string; ticketId?: string; assignee?: string }[];
  };
  check("the board's own link comes back", listed.board === "https://acme.monday.com/boards/222", listed.board);
  check("both open requests are listed", listed.open === 2, String(listed.open));
  const acme = listed.items.find((i) => i.id === "9001");
  check("with status, who has it and the ticket", acme?.status === "Pending" && acme.assignee === "Mark Shaw" && acme.ticketId === "14700", JSON.stringify(acme));
  check("and a link to the item itself", acme?.url === "https://acme.monday.com/boards/222/pulses/9001", acme?.url);
  check("an item filed by hand, with no ticket, is still listed", listed.items.some((i) => i.id === "9002" && i.status === "Stuck" && !i.ticketId));

  handler = () => ({ throws: true });
  const down = await read.list_compliance_requests.execute({});
  check("monday not answering is not reported as an empty board", /did not answer/.test(down) && !/No open/.test(down), down);

  section("A pasted item link can be read");
  handler = () => ({
    json: {
      data: {
        items: [
          {
            id: "9001",
            name: "Acme — DPA",
            board: { id: "222" },
            updates: [{ created_at: "2026-11-25T10:00:00Z", text_body: "Sent the draft to legal.", creator: { name: "Mark Shaw" }, replies: [] }],
          },
        ],
      },
    },
  });
  const comments = JSON.parse(await read.read_dev_item_comments.execute({ item_id: "9001" })) as { url: string; updates: { author: string; text: string }[] };
  check("comments on a compliance item come back with its own board's link", comments.url === "https://acme.monday.com/boards/222/pulses/9001" && comments.updates[0]?.author === "Mark Shaw", JSON.stringify(comments));

  section("Filing a request tells the team in Slack, with the link");
  const ctx = {
    channel: "freshdesk",
    ticket: { id: "14701", subject: "s", description: "d", status: "open", replies: [], requesterEmail: "pat@example.com" },
    product: "jetpackapps",
    appProduct: "vlookup",
    relatedDevItems: [],
  };
  const tools = buildTools(ctx as never, {} as never) as unknown as Record<string, Tool>;
  handler = (body) => {
    if (body.includes("create_update")) return { json: { data: { create_update: { id: "900" } } } };
    if (body.includes("create_item")) return { json: { data: { create_item: { id: "9100", name: "Beta — BAA" } } } };
    return board([]);
  };
  printed.length = 0;
  const filed = await tools.send_to_compliance.execute({ company: "Beta", request: "BAA", summary: "They need a BAA signed." });
  check("the request is filed", /^Filed compliance request/.test(filed) && filed.includes("/boards/222/pulses/9100"), filed);
  const post = printed.find((l) => l.includes("[stub] slack → #esc")) ?? "";
  check("one Slack line goes to the escalation channel", !!post, printed.join(" | ").slice(0, 300));
  check("…linking the item and the ticket", post.includes("<https://acme.monday.com/boards/222/pulses/9100|Beta — BAA>") && post.includes("|#14701>"), post);
  check("…without @channel", !post.includes("<!channel>"), post);

  // The same ticket again: the item exists, so nothing new is announced.
  handler = (body) => {
    if (body.includes("create_update")) return { json: { data: { create_update: { id: "901" } } } };
    return board([
      {
        id: "9100",
        name: "Beta — BAA",
        group: { title: "In Process" },
        column_values: [{ text: "#14701 - https://x.freshdesk.com/a/tickets/14701", type: "link", column: { title: "Ticket" } }],
        updates: [],
      },
    ]);
  };
  printed.length = 0;
  const again = await tools.send_to_compliance.execute({ company: "Beta", request: "BAA", summary: "Deadline is Friday." });
  check("a follow-up lands on the same item", /ALREADY has a compliance request/.test(again), again);
  check("…and is not announced a second time", !printed.some((l) => l.includes("[stub] slack →")), printed.join(" | ").slice(0, 300));

  section("A later note about the request can carry its link");
  const prompt = await buildSystemPrompt({
    ...ctx,
    ticketComplianceItems: [{ id: "9100", title: "Beta — BAA", status: "Pending", url: "https://acme.monday.com/boards/222/pulses/9100" }],
  } as never);
  check("the prompt gives the item's link, for the private note only", prompt.includes("https://acme.monday.com/boards/222/pulses/9100") && /link is for the private note ONLY/.test(prompt));

  realLog(failures ? `\ncompliance-board-read: ${failures} FAILED` : "\ncompliance-board-read: all passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
