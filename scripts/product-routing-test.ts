/**
 * Which dev board does the keyword heuristic pick? Offline, no network.
 *
 *   npx tsx scripts/product-routing-test.ts
 *
 * `inferProduct` chooses between the GetSign board and the Dev Tasks board
 * whenever Freshdesk's cf_product is still empty, so each miss here is an
 * item filed on the wrong team's board. The first three cases are the real
 * tickets that did exactly that (fixed in fix/dev-board-routing).
 */
import { inferProduct, inferAppProduct } from "../lib/context";

interface Case {
  why: string;
  text: string;
  product: "getsign" | "jetpackapps" | "unknown";
  app?: string;
}

const OUTLOOK_FOOTER =
  "Regards, Sijia [cid:2bebbb07-7f] https://emea01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fx.com&excomponenttype=Link&signature=f1LM-PF-8Y0bAedMM8YXN17G7yWDd";

const CASES: Case[] = [
  // ── the three real misroutes ────────────────────────────────────────
  {
    why: "#14733: VLOOKUP named; 'signature' only in Outlook tracking links",
    text: `Vlookup board issue\nHi, we're using VLOOKUP Auto-Link on monday.com and have reached our board limit. ${OUTLOOK_FOOTER}`,
    product: "jetpackapps",
    app: "vlookup",
  },
  {
    why: "#14720: TrackMy named; 'signature' only in an inline-image label",
    text: "TrackMy Question\nWe just installed TrackMy into our Monday account yesterday.\nmarc.w@nbcuni.com<mailto:marc.w@nbcuni.com> [signature_954231893]",
    product: "jetpackapps",
    app: "trackmy",
  },
  {
    why: "#14729: GetSign contract chat that only says 'monday.com board' — triage must decide",
    text: "Sending a new contract on a different row removed previous contract and tracking history\nBoth rows are on the same monday.com board. Dev board search returned no existing items.",
    product: "unknown",
  },

  // ── named app beats another app's vocabulary ───────────────────────
  {
    why: "VLOOKUP named, customer mentions their email signature",
    text: "VLOOKUP not syncing\nSorry, my signature is broken in this email. The lookup column stays empty.",
    product: "jetpackapps",
    app: "vlookup",
  },
  {
    why: "GetSign named beats an Extract-ish word",
    text: "GetSign question\nCan I extract the signed PDF to a file column?",
    product: "getsign",
    app: "getsign",
  },

  // ── GetSign vocabulary still works when nothing else is named ──────
  {
    why: "signer vocabulary, no app named",
    text: "Signer order\nCan the second signer only receive the request after the first one has signed?",
    product: "getsign",
    app: "getsign",
  },
  {
    why: "Get Sign spaced out",
    text: "Purchase of Get Sign\nWe want 20 seats.",
    product: "getsign",
    app: "getsign",
  },
  {
    why: "a getsign URL path is still a clue",
    text: "Help\nThe page https://getsign.jetpackapps.com/templates?id=4 is blank.",
    product: "getsign",
    app: "getsign",
  },
  {
    why: "e-sign guard: 'design' is not GetSign",
    text: "Board design question\nHow should I design my board layout?",
    product: "unknown",
  },

  // ── generic monday talk no longer decides ──────────────────────────
  {
    why: "only 'board' and 'monday.com'",
    text: "Board not loading\nMy monday.com board is slow since yesterday.",
    product: "unknown",
  },
  {
    why: "marketplace still means the app portfolio",
    text: "Marketplace billing\nWhere do I see my marketplace invoice?",
    product: "jetpackapps",
  },
];

let failed = 0;
for (const c of CASES) {
  const product = inferProduct(c.text);
  const app = inferAppProduct(c.text);
  const ok = product === c.product && (c.app === undefined || app === c.app);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.why}\n      product=${product} (want ${c.product})${c.app ? `  app=${app} (want ${c.app})` : ""}`);
}
console.log(`\n${CASES.length - failed}/${CASES.length} passed`);
process.exit(failed ? 1 : 0);
