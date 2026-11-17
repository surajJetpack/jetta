/**
 * Offline test for repeat problems (lib/problems.ts, lib/problem-store.ts):
 * tickets about one malfunction are grouped, the developers are told once on
 * one dev item, and the ticket agent is never told.
 *
 *   npx tsx scripts/problems-test.ts
 *
 * Run it WITHOUT --env-file: with KV credentials set it would write to a real
 * store. The model, monday and Freshdesk are stood in for.
 */
import assert from "node:assert/strict";

for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_VECTOR_REST_URL", "UPSTASH_VECTOR_REST_TOKEN"]) {
  if (process.env[k]) throw new Error(`${k} is set — run this test without --env-file`);
}

async function main() {
  const { config } = await import("../lib/config");
  const store = await import("../lib/problem-store");
  const { shortlistTickets, problemForTicket, problemsApply, shouldRaise, customerCount, raiseProblem } = await import("../lib/problems");
  const { buildSystemPrompt } = await import("../lib/system-prompt");
  const { buildTools } = await import("../lib/tools");
  const { getOpsEvents } = await import("../lib/events");
  type Joiner = import("../lib/problems").Joiner;
  type ProblemOps = import("../lib/problems").ProblemOps;
  type Problem = import("../lib/problem-store").Problem;
  const setMode = (m: "off" | "shadow" | "on") => ((config as { repeatProblems: string }).repeatProblems = m);

  let n = 0;
  const check = (name: string, ok: unknown) => {
    assert.ok(ok, name);
    n++;
  };

  const D = (d: number, h = 9) => new Date(Date.UTC(2026, 10, d, h));
  const EMAIL = (who: string) => ({
    subject: `Error message "Missing recipient email address" (${who})`,
    body: `When I send the contract from the board I get the error "Missing recipient email address", but the email column on the item is filled in. ${who}`,
  });
  const yes: Joiner = async (_s, _b, short) => ({ malfunction: true, same: short.map((_, i) => ({ n: i + 1, confidence: "high" as const })) });
  /** A model that recognises only these earlier tickets as the same malfunction. */
  const only = (ids: string[]): Joiner => async (_s, _b, short) => ({
    malfunction: true,
    same: short.flatMap((x, i) => (ids.includes(x.ticket.id) ? [{ n: i + 1, confidence: "high" as const }] : [])),
  });
  let calls = 0;
  const counting: Joiner = async (s, b, short) => (calls++, yes(s, b, short));

  // ── Grouping ──
  check("the first ticket of its kind joins nothing, and the model is not asked", (await problemForTicket("100", EMAIL("a").subject, EMAIL("a").body, { now: D(1), join: counting, requester: "A@one.example" })) === null && calls === 0);
  check("an unrelated ticket joins nothing, and still the model is not asked", (await problemForTicket("101", "Invoice VAT number", "Please add our VAT number to the invoice for last month.", { now: D(2), join: counting })) === null && calls === 0);

  const short = shortlistTickets("102", EMAIL("b").subject, EMAIL("b").body, await store.listSeen(), D(3));
  check("a second ticket with the same error shortlists the first, not the invoice one", short.length === 1 && short[0].ticket.id === "100");
  check("a ticket more than 30 days later is not compared", shortlistTickets("102", EMAIL("b").subject, EMAIL("b").body, await store.listSeen(), new Date(Date.UTC(2026, 11, 20))).length === 0);

  const second = await problemForTicket("102", EMAIL("b").subject, EMAIL("b").body, { now: D(3), join: counting, requester: "b@two.example" });
  check("the model is asked once, and the two tickets become one problem", calls === 1 && second?.id === "p100" && second.tickets.map((t) => t.id).join() === "100");
  check("the problem is named after the first ticket", second?.title === EMAIL("a").subject);
  check("the earlier ticket now belongs to it too", (await store.getSeen("100"))?.problemId === "p100");
  await problemForTicket("102", EMAIL("b").subject, `${EMAIL("b").body} Any update?`, { now: D(4), join: counting });
  check("a later message on the same ticket is not decided again", calls === 1 && (await store.getProblem("p100"))?.tickets.length === 2);

  check(
    "a how-to question about the same thing joins nothing",
    (await problemForTicket("103", "Where do I set the recipient email address?", "Which column does the recipient email address come from when I send a contract from the board?", {
      now: D(4),
      join: async () => ({ malfunction: false, same: [{ n: 1, confidence: "high" }] }),
    })) === null,
  );
  check(
    "a guess does not group",
    (await problemForTicket("104", EMAIL("c").subject, EMAIL("c").body, { now: D(4), join: async (_s, _b, sh) => ({ malfunction: true, same: sh.map((_, i) => ({ n: i + 1, confidence: "low" as const })) }) })) === null,
  );
  check("without a model nothing is ever grouped", (await problemForTicket("105", EMAIL("d").subject, EMAIL("d").body, { now: D(4), join: null })) === null);
  check(
    "a model that fails groups nothing and does not throw",
    (await problemForTicket("106", EMAIL("e").subject, EMAIL("e").body, { now: D(4), join: async () => { throw new Error("model down"); } })) === null,
  );

  // ── When to raise ──
  const P = (tickets: [string, Date][], afterFix: string[] = []): Problem => ({
    id: "px",
    title: "T",
    tickets: tickets.map(([id, at]) => ({ id, at: at.toISOString(), subject: `s${id}` })),
    afterFix,
    fixes: [],
  });
  check("two tickets are not enough", !shouldRaise(P([["1", D(1)], ["2", D(2)]]), D(3)));
  check("three are", shouldRaise(P([["1", D(1)], ["2", D(2)], ["3", D(3)]]), D(3)));
  check("two are, when one came after a fix was already live", shouldRaise(P([["1", D(1)], ["2", D(2)]], ["2"]), D(3)));
  const same = P([["1", D(1)], ["2", D(2)], ["3", D(3)]]);
  same.tickets.forEach((t) => (t.who = "abc"));
  check("three tickets from ONE customer are one customer, and not enough", customerCount(same, D(3)) === 1 && !shouldRaise(same, D(3)));
  same.tickets[2].who = "def";
  check("nor are two customers with no fix involved", customerCount(same, D(3)) === 2 && !shouldRaise(same, D(3)));
  check("three spread over more than 30 days are not", !shouldRaise(P([["1", new Date(Date.UTC(2026, 8, 1))], ["2", D(2)], ["3", D(3)]]), D(3)));

  // ── Where it applies ──
  setMode("on");
  check("GetSign tickets on Freshdesk", problemsApply({ channel: "freshdesk" }, "getsign"));
  check("not chat, not other apps, not a developer's run", !problemsApply({ channel: "jettachat" }, "getsign") && !problemsApply({ channel: "freshdesk" }, "jetpackapps") && !problemsApply({ channel: "freshdesk", devEvent: {} as never }, "getsign"));
  setMode("off");
  check("and not at all when off", !problemsApply({ channel: "freshdesk" }, "getsign"));

  // ── Raising ──
  const comments: { itemId: string; text: string }[] = [];
  const notes: { ticketId: string; text: string }[] = [];
  const filed: string[] = [];
  let itemFor: Record<string, { id: string; url: string }> = {};
  let boardHit: { id: string; url: string } | null = null;
  let writes = true;
  const ops: ProblemOps = {
    itemForTicket: async (id) => itemFor[id] ?? null,
    searchBoard: async () => boardHit,
    fileItem: async (p) => (writes ? (filed.push(p.id), { id: `new-${p.id}`, url: `https://m/new-${p.id}` }) : null),
    comment: async (itemId, text) => (writes ? (comments.push({ itemId, text }), `u${comments.length}`) : null),
    note: async (ticketId, text) => void notes.push({ ticketId, text }),
  };
  const ctxFor = (id: string, problem: unknown, extra: object = {}) =>
    ({ channel: "freshdesk", ticket: { id, subject: "s", description: "d", status: "open", replies: [] }, account: null, relatedDevItems: [], product: "getsign", appProduct: "getsign", app: "getsign", problem, ...extra }) as never;

  setMode("on");
  const ref102 = await problemForTicket("102", "", "", { now: D(4) });
  check("two tickets, no fix: nothing is raised", (await raiseProblem(ctxFor("102", ref102), { now: D(4), ops })) === "below" && comments.length === 0);

  const third = await problemForTicket("107", EMAIL("f").subject, EMAIL("f").body, { now: D(5), join: only(["100", "102"]) });
  check("a third ticket joins the same problem", third?.id === "p100" && third.tickets.length === 2);

  setMode("shadow");
  check("shadow: logged, nothing written", (await raiseProblem(ctxFor("107", third), { now: D(5), ops })) === "shadow" && comments.length === 0 && notes.length === 0 && filed.length === 0 && (await getOpsEvents({})).some((e) => e.event === "problems.shadow"));
  setMode("off");
  check("off: nothing", (await raiseProblem(ctxFor("107", third), { now: D(5), ops })) === "none");

  setMode("on");
  writes = false;
  check("monday writes off: nothing is claimed", (await raiseProblem(ctxFor("107", third), { now: D(5), ops })) === "writes off" && !(await store.getProblem("p100"))?.raisedAt);
  writes = true;
  check("three tickets, no item anywhere: one is filed and the developers are told", (await raiseProblem(ctxFor("107", third), { now: D(5), ops })) === "raised" && filed.length === 1 && comments.length === 1 && comments[0].itemId === "new-p100");
  check("the address itself is never kept, only a short hash", !JSON.stringify(await store.listSeen()).includes("@"));
  check("the comment lists every ticket and says the grouping is Jetta's", ["100", "102", "107"].every((id) => comments[0].text.includes(`/tickets/${id}`)) && /please check they are the same/.test(comments[0].text));
  check("support gets a note on each of the three tickets, naming the others and the item", notes.length === 3 && notes.find((x) => x.ticketId === "100")!.text.includes("/tickets/107") && notes[0].text.includes("https://m/new-p100"));
  check("the note keeps the count from the customer", /Do not tell the customer how many others/.test(notes[0].text));
  check("a second run for the same ticket says nothing more", (await raiseProblem(ctxFor("107", third), { now: D(5), ops })) === "already" && comments.length === 1 && notes.length === 3);

  const fourth = await problemForTicket("108", EMAIL("g").subject, EMAIL("g").body, { now: D(6), join: only(["100", "102", "107"]) });
  check("a fourth ticket knows the item", fourth?.itemId === "new-p100");
  check("and adds one line on it, not a second alert or a second item", (await raiseProblem(ctxFor("108", fourth), { now: D(6), ops })) === "added" && comments.length === 2 && comments[1].text.includes("/tickets/108") && filed.length === 1);
  check("with one note, on the new ticket only", notes.length === 4 && notes[3].ticketId === "108");

  // A fix that was already live: two tickets are enough, and the item a ticket already has is reused.
  store.clearProblemsForTest();
  const DOCX = (who: string) => ({ subject: `Template editor loads blank canvas (${who})`, body: `The DOCX template editor shows a blank canvas and the document content is not rendering. ${who}` });
  await problemForTicket("200", DOCX("a").subject, DOCX("a").body, { now: D(10), join: yes });
  const docx2 = await problemForTicket("201", DOCX("b").subject, DOCX("b").body, { now: D(11), join: yes });
  itemFor = { "200": { id: "777", url: "https://m/777" } };
  const fix = { key: "fix/docx", summary: "Documents with merge fields render in the editor.", state: "released", when: "15 Oct", urls: ["https://github.com/x/1"], confidence: "high", reason: "r", recent: false };
  const before = comments.length;
  check("two tickets raise when one came after a fix", (await raiseProblem(ctxFor("201", docx2, { recentFixes: [fix] }), { now: D(11), ops })) === "raised");
  check("on the dev item the first ticket already had, with nothing new filed", comments[before].itemId === "777" && filed.length === 1);
  check("and the developers are told the fix did not hold", /arrived after a fix/.test(comments[before].text) && comments[before].text.includes("https://github.com/x/1"));
  check("a fix not yet released does not lower the bar", !shouldRaise({ ...P([["1", D(1)], ["2", D(2)]]) }, D(3)));

  // A strong match on the board is used before anything is filed.
  store.clearProblemsForTest();
  itemFor = {};
  boardHit = { id: "888", url: "https://m/888" };
  for (const [i, id] of ["300", "301", "302"].entries()) await problemForTicket(id, EMAIL(`x${i}`).subject, EMAIL(`x${i}`).body, { now: D(12 + i), join: yes });
  const board = await problemForTicket("302", "", "", { now: D(14) });
  await raiseProblem(ctxFor("302", board), { now: D(14), ops });
  check("an item already on the board for this is reused", comments.at(-1)!.itemId === "888" && filed.length === 1);

  // The daily cap on items Jetta files herself.
  boardHit = null;
  const outcomes: string[] = [];
  for (const base of [400, 500, 600]) {
    store.clearProblemsForTest();
    for (const i of [0, 1, 2]) await problemForTicket(String(base + i), EMAIL(`c${base}${i}`).subject, EMAIL(`c${base}${i}`).body, { now: D(20, i), join: yes });
    outcomes.push(await raiseProblem(ctxFor(String(base + 2), await problemForTicket(String(base + 2), "", "", { now: D(20) })), { now: D(20, 5), ops }));
  }
  check("at most two items a day are filed for repeat problems", outcomes.join() === "raised,raised,over the cap");

  // ── The ticket agent is never told ──
  const told = ctxFor("108", { id: "p100", title: EMAIL("a").subject, tickets: [{ id: "100", at: D(1).toISOString(), subject: "UNIQUE-SIBLING-SUBJECT" }], itemId: "new-p100", itemUrl: "https://m/new-p100" });
  const prompt = await buildSystemPrompt(told);
  check("the prompt does not contain the grouping", !prompt.includes("UNIQUE-SIBLING-SUBJECT") && !prompt.includes("https://m/new-p100") && !/other customers? (have|has) reported/i.test(prompt));

  // ── One item per problem when Jetta files ──
  const file = async (ctx: never) => {
    const tools = buildTools(ctx, { resolutionSent: false } as never) as unknown as Record<string, { execute: (i: unknown, o: unknown) => Promise<string> }>;
    return tools.create_dev_item.execute({ title: "Blank canvas", error_description: "Editor is blank", repro_steps: "Open the editor" }, {});
  };
  setMode("on");
  const joined = await file(told);
  check("a ticket whose problem has an item does not file a second one", !/Created Dev board item/.test(joined));
  setMode("shadow");
  check("in shadow the filing is exactly as before", (await file(told)) === (await file(ctxFor("108", undefined))));
  setMode("on");
  check("a ticket with no problem files as before", (await file(ctxFor("109", undefined))) === (await file(ctxFor("109", { id: "p9", title: "t", tickets: [] }))));

  // ── Forgetting ──
  store.clearProblemsForTest();
  await problemForTicket("900", EMAIL("old").subject, EMAIL("old").body, { now: new Date(Date.UTC(2026, 7, 1)), join: yes });
  await store.pruneProblems(D(20));
  check("a ticket past the window is forgotten", (await store.listSeen()).length === 0);

  console.log(`problems: all ${n} assertions passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
