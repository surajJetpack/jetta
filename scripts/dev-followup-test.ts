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
import { decideFollowUp, nudgeText, workdaysBetween } from "../lib/dev-followup";
import { declinesKb, docText, noAnswer, shouldAskForKb } from "../lib/dev-kb";
import { itemActivity, JETTA_POST_PREFIX } from "../lib/tools/monday";

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

console.log("The nudge counts as an ask next time");
{
  const text = `${JETTA_POST_PREFIX} ${nudgeText("14611", 4, 1)}`;
  const a = itemActivity([{ text_body: text, created_at: day(23) }, { text_body: "dev note", created_at: day(19) }]);
  check("nudge recorded as an ask, not as activity", a.askTimes.length === 1 && a.lastPersonActivityAt === day(19));
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
