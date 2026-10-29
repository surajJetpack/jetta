/**
 * Does the dev follow-up ask only when a customer is really waiting on a
 * really quiet item — and stop after two asks? And does the KB loop know a
 * "no KB" when it sees one?
 *
 *   npx tsx scripts/dev-followup-test.ts
 *
 * No network for the decisions. The last block reads a PDF and a .docx
 * through docText via data: URLs, so the extractors are exercised for real.
 */
import { decideFollowUp, decideUnlinkedFollowUp, nudgeText, questionNudgeText, unlinkedNudgeText, workdaysBetween } from "../lib/dev-followup";
import { declinesKb, docText, noAnswer, shouldAskForKb } from "../lib/dev-kb";
import { itemActivity, JETTA_POST_PREFIX, NUDGE_PHRASE } from "../lib/tools/monday";

export {};

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok    ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`);
  }
}

const SAT = [6];
// 2026-10-19 is a Monday.
const day = (d: number, h = 9) => new Date(Date.UTC(2026, 9, d, h)).toISOString();

console.log("Working days (Saturday off)");
{
  check("Mon → Thu = 3", workdaysBetween(day(19), new Date(day(22)), SAT) === 3);
  check("Fri → Mon skips Saturday = 2", workdaysBetween(day(23), new Date(day(26)), SAT) === 2);
  check("same day = 0", workdaysBetween(day(19, 1), new Date(day(19, 20)), SAT) === 0);
  check("garbage date = 0", workdaysBetween("nope", new Date(day(22)), SAT) === 0);
}

console.log("Follow-up decisions");
{
  const rules = { quietWorkdays: 3, weekend: SAT };
  const base = {
    group: "Client reported Field Issues",
    devStatus: "Working on it",
    lastPersonActivityAt: day(19),
    devStatusChangedAt: null as string | null,
    createdAt: day(12),
    askTimes: [] as string[],
    type: "Bugs and Field Issues",
  };
  const d = (over: Partial<typeof base>, ticket: string | null = "open", now = day(23)) =>
    decideFollowUp({ ...base, ...over }, ticket, new Date(now), rules);

  check("quiet 4 workdays, customer waiting → first ask", d({}).action === "ask" && (d({}) as { n: number }).n === 1);
  check("quiet only 2 workdays → nothing", d({}, "open", day(21)).action === "none");
  check("a status change resets the clock", d({ devStatusChangedAt: day(22) }).action === "none");
  check("one ask 3+ workdays ago → second ask", (() => { const r = d({ askTimes: [day(23)] }, "open", day(27)); return r.action === "ask" && r.n === 2; })());
  check("one ask yesterday → wait", d({ askTimes: [day(22)] }).action === "none");
  check("two asks, still silent → escalate", d({ askTimes: [day(20), day(23)] }, "open", day(27)).action === "escalate");
  check("asks from BEFORE the last activity don't count", (() => { const r = d({ askTimes: [day(14), day(16)], lastPersonActivityAt: day(19) }); return r.action === "ask" && r.n === 1; })());
  check("ticket resolved → nothing", d({}, "resolved").action === "none");
  check("FD 'waiting on customer' alone does not stop it (set after every reply)", d({}, "waiting on customer").action === "ask");
  check("…the item's Waiting Customer does", d({ devStatus: "Waiting Customer" }, "waiting on customer").action === "none");
  check("ticket status unknown (FD down) → nothing", d({}, null).action === "none");
  check("developer waiting on support → nothing", d({ devStatus: "Need more info" }).action === "none");
  check("on HOLD → nothing", d({ devStatus: "HOLD" }).action === "none");
  check("finished → nothing", d({ devStatus: "Deployed to Prod" }).action === "none");
  check("Done group → nothing", d({ group: "Done" }).action === "none");
  check("feature request → nothing", d({ type: "Feature Enhancements" }).action === "none");
  check("GetSign 'Done' in a live group is still in flight → ask", d({ devStatus: "Done" }).action === "ask");
}

console.log("Any post of Jetta's restarts the clock");
{
  const rules = { quietWorkdays: 3, weekend: SAT };
  const item = {
    group: "Client reported Field Issues",
    devStatus: "Working on it",
    lastPersonActivityAt: day(12),
    devStatusChangedAt: null,
    createdAt: day(5),
    askTimes: [] as string[],
    type: null,
  };
  check("a hand-written ask yesterday → wait", decideFollowUp({ ...item, lastJettaPostAt: day(22) }, "open", new Date(day(23)), rules).action === "none");
  check("…3 workdays later → first ask", (() => { const r = decideFollowUp({ ...item, lastJettaPostAt: day(22) }, "open", new Date(day(26)), rules); return r.action === "ask" && r.n === 1; })());
  check("a post from BEFORE the last activity doesn't hold it", decideFollowUp({ ...item, lastJettaPostAt: day(9) }, "open", new Date(day(23)), rules).action === "ask");
  check("itemActivity reports her newest post", itemActivity([{ text_body: `${JETTA_POST_PREFIX} hi`, created_at: day(22) }, { text_body: `${JETTA_POST_PREFIX} relay`, created_at: day(20) }]).lastJettaPostAt === day(22));
}

console.log("Unlinked items");
{
  const rules = { quietWorkdays: 3, weekend: SAT };
  const sujata = { id: "53608181", name: "Sujata Shrestha" };
  const swejal = { id: "78345437", name: "Swejal Shrestha" };
  const base = {
    group: "Client req",
    devStatus: "Working on it",
    lastPersonActivityAt: day(14),
    devStatusChangedAt: null as string | null,
    createdAt: day(12),
    askTimes: [] as string[],
    type: "Bugs and Field Issues" as string | null,
    developers: [swejal] as { id: string; name: string }[],
    reporters: [sujata] as { id: string; name: string }[],
  };
  const d = (over: Partial<typeof base> = {}, now = day(23)) => decideUnlinkedFollowUp({ ...base, ...over }, new Date(now), rules);
  const about = (over: Partial<typeof base>) => { const r = d(over); return r.action === "ask" ? r.about : r.action; };

  check("filed by support, dev quiet → ask the developer", about({}) === "developer");
  check("Waiting Customer → ask the Reporter", about({ devStatus: "Waiting Customer" }) === "customer");
  check("no Developer → ask the Reporter who owns it", about({ developers: [] }) === "owner");
  check("no Reporter → nothing (nobody in support is waiting)", d({ reporters: [] }).action === "none");
  check("Internal Bug group → nothing", d({ group: "Internal Bug" }).action === "none");
  check("feature request → nothing", d({ type: "Feature Enhancements" }).action === "none");
  check("on HOLD → nothing", d({ devStatus: "HOLD" }).action === "none");
  check("quiet 2 workdays → nothing", d({}, day(16)).action === "none");
  check("quiet over 60 workdays → abandoned, nothing", (() => { const r = d({ lastPersonActivityAt: "2026-06-01T09:00:00Z", createdAt: "2026-05-01T09:00:00Z" }); return r.action === "none" && r.reason.startsWith("abandoned"); })());
  check("two asks unanswered → escalate", d({ askTimes: [day(19), day(22)] }, day(27)).action === "escalate");

  const item = { devStatus: "Waiting Customer", reporters: [sujata] };
  for (const a of ["developer", "customer", "owner"] as const)
    check(`'${a}' nudge carries NUDGE_PHRASE, so it counts as an ask`, unlinkedNudgeText(item, a, 5, 1).includes(NUDGE_PHRASE));
  check("developer nudge names the Reporter", unlinkedNudgeText(item, "developer", 5, 1).includes("Sujata Shrestha"));
}

console.log("The nudge counts as an ask next time");
{
  const text = `${JETTA_POST_PREFIX} ${nudgeText("14611", 4, 1)}`;
  const a = itemActivity([{ text_body: text, created_at: day(23) }, { text_body: "dev note", created_at: day(19) }]);
  check("nudge recorded as an ask, not as activity", a.askTimes.length === 1 && a.lastPersonActivityAt === day(19));
}

console.log("Support pinging the item is a chase, not developer activity");
{
  const rules = { quietWorkdays: 3, weekend: SAT };
  const prashant = "111";
  const cherryl = "222";
  // #14600: filed day 19, Jetta chased day 20, support pinged day 23, no developer ever spoke.
  const posts = [
    { text_body: `${JETTA_POST_PREFIX} The customer on ticket #14600 is asking for an update.`, created_at: day(20), creator: { id: "82879261" } },
    { text_body: "@Prashant whats the update on this?", created_at: day(23), creator: { id: cherryl } },
  ];
  const a = itemActivity(posts, [prashant]);
  check("support's comment is not developer activity", a.lastDevActivityAt === null && a.otherPersonPostTimes.length === 1);
  check("…but is still person activity for the relay's chase guard", a.lastPersonActivityAt === day(23));
  const item = { group: "Bugs", devStatus: "Ready to start", devStatusChangedAt: null, createdAt: day(19), type: null, ...a };
  check("support's ping restarts the clock: wait", decideFollowUp(item, "open", new Date(day(24)), rules).action === "none");
  check("…then the two asks are used up → escalate, not a fresh round", decideFollowUp(item, "open", new Date(day(28)), rules).action === "escalate");
  const devSpoke = itemActivity([...posts, { text_body: "looking at it", created_at: day(24), creator: { id: prashant } }], [prashant]);
  check("a developer's comment does reset it: a fresh first ask, not escalation", (() => { const r = decideFollowUp({ ...item, ...devSpoke }, "open", new Date(day(28)), rules); return r.action === "ask" && r.n === 1; })());
  const noDev = itemActivity(posts, []);
  check("no Developer on the item → every comment is activity, as before", noDev.otherPersonPostTimes.length === 0 && noDev.lastPersonActivityAt === day(23));
  check("escalation carries when the silence began", (() => { const r = decideFollowUp(item, "open", new Date(day(28)), rules); return r.action === "escalate" && r.since === day(19); })());
}

console.log("Jetta's own unanswered question is chased");
{
  const rules = { quietWorkdays: 3, weekend: SAT };
  const q = { at: day(20) };
  const base = {
    group: "Done",
    devStatus: "Done",
    lastPersonActivityAt: day(19),
    devStatusChangedAt: day(19),
    createdAt: day(12),
    askTimes: [] as string[],
    type: "Question",
    lastJettaPostAt: day(20),
  };
  const d = (over: Partial<typeof base> = {}, now = day(24), ticket: string | null = "open") => decideFollowUp({ ...base, ...over }, ticket, new Date(now), rules, q);
  check("Done item, question unanswered 3 workdays → chase it", (() => { const r = d(); return r.action === "ask" && r.n === 1 && r.question === true; })());
  check("…on Waiting Customer too (#14646)", d({ group: "Bugs", devStatus: "Waiting Customer" }).action === "ask");
  check("asked yesterday → wait", (() => { const r = d({}, day(21)); return r.action === "none" && r.reason.startsWith("question open"); })());
  check("someone answered → back to the normal rules (Done → nothing)", (() => { const r = d({ lastPersonActivityAt: day(21) }); return r.action === "none" && !r.reason.startsWith("question open"); })());
  check("ticket closed → nothing", d({}, day(24), "closed").action === "none");
  check("chased once 3+ workdays ago → second chase", (() => { const r = d({ askTimes: [day(23)] }, day(27)); return r.action === "ask" && r.n === 2; })());
  check("chased twice → escalate", (() => { const r = d({ askTimes: [day(23), day(27)] }, day(30)); return r.action === "escalate" && r.question === true; })());
  check("no question → Done item is left alone", decideFollowUp(base, "open", new Date(day(24)), rules).action === "none");
  const chase = itemActivity([{ text_body: `${JETTA_POST_PREFIX} ${questionNudgeText("14611", 1)}`, created_at: day(24) }]);
  check("the chase counts as an ask, not as an answer", chase.askTimes.length === 1 && chase.lastPersonActivityAt === null);
}

console.log("KB loop");
{
  check("'no KB' declines", declinesKb("no KB"));
  check("'No KB needed, it was a config issue' declines", declinesKb("No KB needed, it was a config issue"));
  check("'nothing for the KB' declines", declinesKb("nothing for the KB"));
  check("an explanation does not decline", !declinesKb("Customers need to re-authorise the integration after an owner change"));
  check("'not knowing' is not 'no kb'", !declinesKb("Not knowing the webhook id is the real problem"));
  check("ask on Deployed to Prod for a bug", shouldAskForKb({ type: "Bugs and Field Issues" }, "Deployed to Prod"));
  check("ask on Not an Issue", shouldAskForKb({ type: null }, "Not an Issue"));
  check("not on Could not Replicate", !shouldAskForKb({ type: null }, "Could not Replicate"));
  check("not for Question items (drafted from the answer instead)", !shouldAskForKb({ type: "Question" }, "Deployed to Prod"));
  check(
    "a draft that says the resolution wasn't captured is not saved",
    noAnswer({ title: "No resolution captured: automations inactive", body: "x" }) &&
      noAnswer({ title: "Automations inactive", body: "The resolution for this issue was not captured in the thread." }),
  );
  check("a real how-to is saved", !noAnswer({ title: "Reactivating automations", body: "1. Open Automations. 2. Copy the ID." }));
}

async function docs() {
  console.log("Reading developers' documents");
  // Minimal one-page PDF with the text "Reauthorise after owner change".
  const pdfBody = (objs: string[]) => {
    let out = "%PDF-1.4\n";
    const offs: number[] = [];
    objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const x = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
    return out;
  };
  const stream = "BT /F1 12 Tf 20 100 Td (Reauthorise after owner change) Tj ET";
  const pdf = pdfBody([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]);
  const pdfUrl = `data:application/pdf;base64,${Buffer.from(pdf, "latin1").toString("base64")}`;
  const t = await docText({ name: "fix.pdf", extension: "pdf", url: pdfUrl, size: pdf.length }).catch((e) => `ERR ${e}`);
  check("PDF text extracted", typeof t === "string" && t.includes("Reauthorise after owner change"), String(t));

  const md = "# How to\nOpen Automations and re-select the webhook.";
  const mdT = await docText({ name: "howto.md", extension: "md", url: `data:text/markdown;base64,${Buffer.from(md).toString("base64")}`, size: md.length });
  check("Markdown read as-is", mdT === md);
  check("an image is not a document", (await docText({ name: "a.png", extension: "png", url: "data:,", size: 3 })) === null);
  check("a 20MB file is skipped", (await docText({ name: "big.pdf", extension: "pdf", url: "data:,", size: 20 * 1024 * 1024 })) === null);
}

docs().then(() => {
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
});
