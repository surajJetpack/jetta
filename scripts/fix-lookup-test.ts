/**
 * Offline test for the fix lookup (lib/fix-lookup.ts) and its store
 * (lib/fix-store.ts): a ticket is matched to the fix that is about it, the
 * finding reaches support and the developer, and it never reaches the prompt.
 *
 *   npx tsx scripts/fix-lookup-test.ts
 *
 * Run it WITHOUT --env-file: with KV credentials set it would write to a real
 * store.
 */
import assert from "node:assert/strict";

for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_VECTOR_REST_URL", "UPSTASH_VECTOR_REST_TOKEN"]) {
  if (process.env[k]) throw new Error(`${k} is set — run this test without --env-file`);
}

async function main() {
  const { config } = await import("../lib/config");
  const { mergeFix, saveFixes, listFixes, clearFixesForTest, FIX_KEEP_DAYS } = await import("../lib/fix-store");
  const { words, shortlistFixes, relatedFixes, lookupApplies, lookupForTicket, supportNote, devEvidence, noteRelatedFixes } = await import("../lib/fix-lookup");
  const { contextBody } = await import("../lib/tools/monday");
  const { buildSystemPrompt } = await import("../lib/system-prompt");
  const { buildTools } = await import("../lib/tools");
  const { getOpsEvents } = await import("../lib/events");
  type ShippedFix = import("../lib/fix-store").ShippedFix;
  const setMode = (m: "off" | "shadow" | "on") => ((config as { fixLookup: string }).fixLookup = m);

  let n = 0;
  const check = (name: string, ok: unknown) => {
    assert.ok(ok, name);
    n++;
  };

  const NOW = new Date("2026-11-17T08:00:00Z");
  const fix = (key: string, summary: string, o: Partial<ShippedFix> = {}): ShippedFix => ({
    key,
    title: `fix: ${summary}`,
    summary,
    body: "",
    customerVisible: true,
    prs: [{ repo: "getsign-board-view", number: 1, url: `https://github.com/Jetpack-Work-Labs/getsign-board-view/pull/${key.length}` }],
    state: "released",
    mergedAt: "2026-11-07T10:00:00Z",
    releasedAt: "2026-11-09T09:11:00Z",
    ...o,
  });

  // ── The store ──
  const half = fix("fix/a", "Cancelled sessions show as Cancelled", { state: "merged", releasedAt: undefined });
  const other = fix("fix/a", "ignored: the first label is kept", { prs: [{ repo: "getsign-backend", number: 2, url: "u2" }], mergedAt: "2026-11-08T10:00:00Z" });
  const both = mergeFix(half, other);
  check("two halves of a fix pool their pull requests", both.prs.length === 2);
  check("released wins over merged, and the first label and the first merge are kept", both.state === "released" && both.summary === half.summary && both.mergedAt === half.mergedAt);
  check("a released fix is never merged again", mergeFix(both, half).state === "released" && mergeFix(both, half).releasedAt === both.releasedAt);
  check("a later release does not move the day it first shipped", mergeFix(both, fix("fix/a", "x", { releasedAt: "2026-11-16T09:00:00Z" })).releasedAt === "2026-11-09T09:11:00Z");

  const old = new Date(NOW.getTime() - (FIX_KEEP_DAYS + 5) * 86400000).toISOString();
  await saveFixes([fix("fix/old", "Something long ago", { mergedAt: old, releasedAt: old }), half], NOW);
  check("a fix too old to matter is not kept", (await listFixes()).map((f) => f.key).join() === "fix/a");
  await saveFixes([other], NOW);
  check("saving the second half updates the record, it does not add one", (await listFixes()).length === 1 && (await listFixes())[0].prs.length === 2);
  clearFixesForTest();

  // ── The shortlist ──
  const fixes = [
    fix("fix/cancelled", "Cancelled signing sessions no longer show as Active in the board Awaiting list."),
    fix("fix/docx", "Word templates with checkboxes no longer upload as an empty file.", { state: "merged", releasedAt: undefined, mergedAt: "2026-11-15T10:00:00Z" }),
    fix("fix/reminder", "Reminder emails are sent in the account time zone."),
    fix("chore/ci", "Cancelled sessions awaiting list build pipeline cache.", { customerVisible: false }),
    fix("fix/old-release", "Signer order is kept when a workflow is edited.", { releasedAt: "2026-09-20T09:00:00Z" }),
  ];
  const T = {
    subject: "Cancelled session still showing in Awaiting",
    body: "Hi, I cancelled a signing session yesterday but it still shows as Active in the Awaiting list on our board. Can you check?",
  };
  check("common words carry no weight", !words("the document is not working, please help with signing").size);
  const short = shortlistFixes(T.subject, T.body, fixes);
  check("the fix about the ticket's problem is shortlisted first", short[0]?.fix.key === "fix/cancelled");
  check("fixes about something else are not", !short.some((s) => s.fix.key === "fix/reminder" || s.fix.key === "fix/docx"));
  check("an internal change is never shortlisted, whatever it says", !short.some((s) => s.fix.key === "chore/ci"));
  check("a how-to question shortlists nothing", shortlistFixes("How do I add a second signer?", "I want two people to sign the same document.", fixes).length === 0);

  // ── The lookup ──
  const yes = async () => [{ n: 1, confidence: "high" as const, reason: "Same list, same symptom." }];
  const found = await relatedFixes(T.subject, T.body, { fixes, now: NOW, confirm: yes });
  check("a confirmed match is reported with its state and reason", found.length === 1 && found[0].key === "fix/cancelled" && found[0].state === "released" && found[0].when === "9 Nov" && found[0].confidence === "high");
  check("shipped eight days ago: inside the regression window", found[0].recent);
  check("a guess is dropped", (await relatedFixes(T.subject, T.body, { fixes, now: NOW, confirm: async () => [{ n: 1, confidence: "low", reason: "x" }] })).length === 0);
  check("the model saying nothing matches means nothing is reported", (await relatedFixes(T.subject, T.body, { fixes, now: NOW, confirm: async () => [] })).length === 0);
  check("a number that is not on the shortlist is ignored", (await relatedFixes(T.subject, T.body, { fixes, now: NOW, confirm: async () => [{ n: 9, confidence: "high", reason: "x" }] })).length === 0);
  let asked = 0;
  await relatedFixes("How do I add a second signer?", "Two people to sign.", { fixes, now: NOW, confirm: async () => (asked++, []) });
  check("with nothing shortlisted the model is not asked", asked === 0);
  const noModel = await relatedFixes(T.subject, T.body, { fixes, now: NOW, confirm: null });
  check("without a model only a strong overlap is reported, as 'possible'", noModel.length === 1 && noModel[0].confidence === "possible");
  check("a lookup that breaks reports nothing and does not throw", (await relatedFixes(T.subject, T.body, { fixes, now: NOW, confirm: async () => { throw new Error("model down"); } })).length === 0);

  const docx = await relatedFixes("Word template uploads empty", "Our Word template with checkboxes uploads as an empty file.", { fixes, now: NOW, confirm: yes });
  check("a fix not yet released is reported as waiting, and is never a regression", docx[0]?.state === "merged" && docx[0].when === "15 Nov" && !docx[0].recent);
  const signer = await relatedFixes("Signer order lost", "When I edit the workflow the signer order is not kept.", { fixes, now: NOW, confirm: yes });
  check("a fix shipped two months ago is outside the regression window", signer[0]?.state === "released" && !signer[0].recent);

  // ── Where it applies ──
  setMode("on");
  check("GetSign tickets on Freshdesk", lookupApplies({ channel: "freshdesk" }, "getsign"));
  check("not chat", !lookupApplies({ channel: "jettachat" }, "getsign"));
  check("not the other apps", !lookupApplies({ channel: "freshdesk" }, "jetpackapps"));
  check("not a run a developer started", !lookupApplies({ channel: "freshdesk", devEvent: {} as never }, "getsign"));
  setMode("off");
  check("and not at all when switched off", !lookupApplies({ channel: "freshdesk" }, "getsign"));

  // ── What is written ──
  const note = supportNote(found);
  check("the note says it is for support and the customer has not been told", /support only/i.test(note) && /has not been told/.test(note));
  check("it gives the state, the reason and the link", note.includes("In production since 9 Nov") && note.includes("Same list, same symptom.") && note.includes("github.com"));
  check("it raises the regression for a recent release", /may have caused it/.test(note));
  check("and warns against giving a date for an unreleased fix", /do not give the customer a date/.test(supportNote(docx)) && supportNote(docx).includes("not yet released"));
  check("nothing found, nothing for the developer", devEvidence([]) === null && devEvidence(undefined) === null);
  check("a recent release is put to the developer as a possible cause", devEvidence(found)!.startsWith("Possibly related to the 9 Nov release"));
  const itemBody = contextBody(
    { title: "t", product: "getsign", accountUrl: "a", errorDescription: "e", reproSteps: "r", freshdeskTicketUrl: "f", releaseEvidence: devEvidence(found) },
    false,
  );
  check("the dev item carries the changes, marked as Jetta's lead", itemBody.includes("Recent changes in this area") && itemBody.includes("Possibly related to the 9 Nov release"));
  check("and nothing is added when there is nothing", !contextBody({ title: "t", product: "getsign", accountUrl: "a", errorDescription: "e", reproSteps: "r", freshdeskTicketUrl: "f" }, false).includes("Recent changes"));

  // ── The ticket agent is never told ──
  const ctx = {
    channel: "freshdesk",
    ticket: { id: "14900", subject: T.subject, description: T.body, status: "open", replies: [] },
    account: null,
    relatedDevItems: [],
    product: "getsign",
    appProduct: "getsign",
    app: "getsign",
    recentFixes: found,
  } as never;
  const prompt = await buildSystemPrompt(ctx);
  check("the prompt does not contain the finding", !prompt.includes(found[0].summary) && !prompt.includes(found[0].reason) && !/github\.com\/Jetpack-Work-Labs/.test(prompt));
  const tools = buildTools(ctx, { resolutionSent: false } as never);
  check("and no tool exists to fetch it", !Object.keys(tools).some((t) => /fix|release/.test(t)));

  // ── The private note ──
  const run = { ...(ctx as object) } as never;
  setMode("off");
  check("off: nothing", (await noteRelatedFixes(run)) === "none");
  setMode("shadow");
  check("shadow: logged, not written", (await noteRelatedFixes(run)) === "shadow" && (await getOpsEvents({})).some((e) => e.event === "fixlookup.shadow"));
  setMode("on");
  check("on: support is told", (await noteRelatedFixes(run)) === "noted");
  check("once per ticket per fix, so a second customer message does not repeat it", (await noteRelatedFixes(run)) === "already noted");
  const second = { ...(ctx as object), recentFixes: [...found, ...docx] } as never;
  check("a different fix on the same ticket is still told", (await noteRelatedFixes(second)) === "noted");
  check("no findings, no note", (await noteRelatedFixes({ ...(ctx as object), recentFixes: [] } as never)) === "none");

  // ── Remembered per ticket ──
  await saveFixes(fixes, NOW);
  let calls = 0;
  const counted = async () => (calls++, [{ n: 1, confidence: "high" as const, reason: "r" }]);
  const a = await lookupForTicket("15000", T.subject, T.body, { now: NOW, confirm: counted });
  const b = await lookupForTicket("15000", T.subject, T.body, { now: NOW, confirm: counted });
  check("the same ticket text is looked up once", a.length === 1 && b.length === 1 && calls === 1);
  await lookupForTicket("15000", T.subject, `${T.body}\nIt is still Active today.`, { now: NOW, confirm: counted });
  check("a new customer message looks again", calls === 2);

  console.log(`fix-lookup: all ${n} assertions passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
