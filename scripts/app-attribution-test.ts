/**
 * Can Jetta actually tell the nine apps apart?
 *
 *   npx tsx --env-file=.env.local scripts/app-attribution-test.ts
 *   npx tsx --env-file=.env.local scripts/app-attribution-test.ts --keyword-only
 *
 * "jetpackapps" is a portfolio, so the only attribution worth having names the
 * app. This measures whether it does, on cases chosen to be hard in the ways
 * real tickets are hard:
 *
 *   named       — the app is named, but spelled how customers spell it
 *   semantic    — the app is never named; only the described behaviour says which
 *   confusable  — two apps plausibly fit; the details decide
 *   none        — genuinely no app in the ticket, and "unknown" is the right answer
 *
 * The confusable set is the real test. Any classifier gets "VLOOKUP not working"
 * right; telling a Smart Columns duplicate-detection question from a VLOOKUP
 * board-matching one is where attribution actually earns its keep.
 */
import { inferAppProduct, triageTicket } from "../lib/context";
import { appName } from "../lib/types";
import { config } from "../lib/config";

const keywordOnly = process.argv.includes("--keyword-only");

interface Case {
  kind: "named" | "semantic" | "confusable" | "none";
  subject: string;
  body: string;
  expect: string;
}

const CASES: Case[] = [
  // ── named, spelled the way customers actually type it ──────────────
  { kind: "named", subject: "V lookup Not responding", body: "The app stopped working this morning.", expect: "vlookup" },
  { kind: "named", subject: "Purchase of Get Sign", body: "We would like to buy a licence for 20 users.", expect: "getsign" },
  { kind: "named", subject: "Track My not updating", body: "Parcels are not refreshing on the board.", expect: "trackmy" },
  { kind: "named", subject: "Question about Extract-AI", body: "Can it read scanned PDFs?", expect: "extract" },
  { kind: "named", subject: "Smart columns SLA", body: "The SLA column stopped counting.", expect: "smartcolumns" },
  { kind: "named", subject: "Pivot Report Pro licence", body: "How many seats does our plan include?", expect: "pivotreports" },
  { kind: "named", subject: "jet scan HR question", body: "Does it parse CVs in French?", expect: "jetscan" },
  { kind: "named", subject: "Job Flows candidates", body: "Candidates are not moving between groups.", expect: "jobflows" },
  { kind: "named", subject: "Triggerly QR", body: "The QR code scan does not fire the automation.", expect: "triggerly" },

  // ── semantic: the app is never named ───────────────────────────────
  { kind: "semantic", subject: "Document not generating", body: "I send the signature request but the signer never receives a document to sign.", expect: "getsign" },
  { kind: "semantic", subject: "Copy & Sync Items - Bulk Sync skips specific items", body: "When syncing items between my two connected boards, some rows never copy across.", expect: "vlookup" },
  { kind: "semantic", subject: "Signer order", body: "Can I make the second person only receive the request after the first one has signed?", expect: "getsign" },
  { kind: "semantic", subject: "Parcel status stuck", body: "The courier says delivered but the tracking number on my board still shows in transit.", expect: "trackmy" },
  { kind: "semantic", subject: "Reading invoices", body: "I want to pull the totals out of PDF invoices in my email straight into board columns.", expect: "extract" },
  { kind: "semantic", subject: "Currency", body: "Our board shows USD but the team needs EUR in the same column.", expect: "smartcolumns" },

  // ── confusable: two apps plausibly fit ─────────────────────────────
  { kind: "confusable", subject: "Duplicate rows", body: "I need the board to warn me when someone creates an item with a name that already exists on that same board.", expect: "smartcolumns" },
  { kind: "confusable", subject: "Items not matching", body: "The lookup column should pull the client name from my other board but it stays empty.", expect: "vlookup" },
  { kind: "confusable", subject: "Reading a CV", body: "We upload candidate resumes and want the skills and years of experience parsed into the hiring board.", expect: "jetscan" },
  { kind: "confusable", subject: "Cross-tab of spend", body: "I want a table of spend by vendor across months as a widget on my dashboard.", expect: "pivotreports" },
  { kind: "confusable", subject: "Fields on the PDF", body: "The name and date boxes I placed on the contract come out blank in the completed PDF.", expect: "getsign" },

  // ── none: no app in the ticket at all ──────────────────────────────
  { kind: "none", subject: "VAT number on invoice", body: "Please add our VAT number to the last three invoices.", expect: "unknown" },
  { kind: "none", subject: "Data Processing Agreement", body: "Can you send a signed DPA for our compliance review?", expect: "unknown" },
  { kind: "none", subject: "Cancel my subscription", body: "We no longer need this, please cancel the renewal.", expect: "unknown" },
  // "signed" here means countersigned by us, not the e-signature product —
  // this misfiled as GetSign before the triage prompt called it out.
  { kind: "none", subject: "Security questionnaire", body: "Attached is our vendor security review, please complete and return it signed.", expect: "unknown" },
  { kind: "none", subject: "W-9 request", body: "Our finance team needs a signed W-9 before they can pay the invoice.", expect: "unknown" },
];

/**
 * Words the keyword layer must NOT claim. These are the failures you never see:
 * a pattern that over-matches produces a confident wrong answer, and it looks
 * exactly like a correct one on the dashboard. /e-?\s?sign/ without a leading
 * boundary matched the "e"+"sign" inside DESIGN; bare /mapping/ claimed column
 * mapping, which is a VLOOKUP concept.
 */
const MUST_NOT_MATCH: [string, string][] = [
  ["design", "getsign"],
  ["redesign", "getsign"],
  ["designer", "getsign"],
  ["designed", "getsign"],
  ["resign", "getsign"],
  ["a workspace designed to improve productivity", "getsign"],
  ["mapping of board column", "getsign"],
  ["field mapping", "getsign"],
];

/** …and names that must still resolve, however they're spelled. */
const MUST_MATCH: [string, string][] = [
  ["get sign", "getsign"], ["getsign", "getsign"], ["Get-Sign", "getsign"],
  ["e-sign", "getsign"], ["esign", "getsign"], ["signature request", "getsign"],
  ["signatory", "getsign"], ["the signer never got it", "getsign"],
  ["v lookup", "vlookup"], ["vlookup", "vlookup"], ["V-Lookup", "vlookup"],
  ["track my", "trackmy"], ["trackmy", "trackmy"],
  ["job flows", "jobflows"], ["smart column", "smartcolumns"],
  ["jet scan", "jetscan"], ["pivot report", "pivotreports"],
];

function patternHygiene(): number {
  let bad = 0;
  console.log("── keyword pattern hygiene (deterministic) ──");
  for (const [text, app] of MUST_NOT_MATCH) {
    if (inferAppProduct(text) === app) {
      console.log(`  FAIL  "${text}" must NOT resolve to ${appName(app)}`);
      bad++;
    }
  }
  for (const [text, app] of MUST_MATCH) {
    const got = inferAppProduct(text);
    if (got !== app) {
      console.log(`  FAIL  "${text}" → ${appName(got)}, expected ${appName(app)}`);
      bad++;
    }
  }
  console.log(bad ? `  ${bad} failures\n` : `  ${MUST_NOT_MATCH.length + MUST_MATCH.length} checks passed\n`);
  return bad;
}

async function main() {
  const hygieneFailures = patternHygiene();
  console.log(`${CASES.length} classification cases · keyword layer${keywordOnly ? " only" : " + LLM triage"}\n`);
  if (!keywordOnly && !config.openrouter.apiKey && !config.anthropic.apiKey) {
    console.log("No LLM key configured — run with --keyword-only, or set the key.\n");
    process.exit(1);
  }

  const byKind = new Map<string, { pass: number; total: number }>();
  const misses: string[] = [];
  let kwResolved = 0;

  for (const c of CASES) {
    const text = `${c.subject}\n${c.body}`;
    const keyword = inferAppProduct(text);
    if (keyword !== "unknown") kwResolved++;

    // Exactly the precedence the live path uses (minus cf_product, which these
    // synthetic tickets don't have): keyword first, model only as the fallback.
    let final = keyword;
    let via = "keyword";
    if (keyword === "unknown" && !keywordOnly) {
      const t = await triageTicket(c.subject, c.body);
      final = t.app;
      via = "triage";
    }

    const ok = final === c.expect;
    const b = byKind.get(c.kind) ?? { pass: 0, total: 0 };
    b.total++;
    if (ok) b.pass++;
    byKind.set(c.kind, b);

    console.log(
      `  ${ok ? "PASS" : "FAIL"}  [${c.kind.padEnd(10)}] ${c.subject.slice(0, 42).padEnd(44)} → ${appName(final).padEnd(18)} via ${via}`,
    );
    if (!ok) misses.push(`[${c.kind}] "${c.subject}" → ${appName(final)}, expected ${appName(c.expect)}`);
  }

  console.log("\n── by case kind ──");
  for (const [kind, b] of byKind) {
    console.log(`  ${kind.padEnd(12)} ${b.pass}/${b.total}`);
  }
  const pass = [...byKind.values()].reduce((s, b) => s + b.pass, 0);
  console.log(`\n  keyword layer alone resolved ${kwResolved}/${CASES.length} (rest fell through to triage)`);
  console.log(`  OVERALL ${pass}/${CASES.length} classification, ${hygieneFailures === 0 ? "hygiene clean" : `${hygieneFailures} HYGIENE FAILURES`}`);
  if (misses.length) {
    console.log("\n── misses ──");
    for (const m of misses) console.log(`  ${m}`);
  }
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
