/**
 * Does the monday session-token check actually keep out what it should?
 *
 *   npx tsx scripts/monday-session-token-test.ts
 *
 * No network and no monday app: tokens are minted here with a known secret,
 * which is exactly what monday does with the app's client secret.
 *
 * What this guards is a real escalation of trust. An unverified account slug
 * is a sentence in the prompt saying "they say they are on acme"; a verified
 * one tells Jetta to raise trial and discount requests against that account
 * without asking. Every check below is a way the second could be obtained
 * without the first.
 */
import crypto from "node:crypto";

// Set before the import: lib/config snapshots process.env once.
process.env.MONDAY_CLIENT_SECRET_VLOOKUP = "vlookup-secret";
process.env.MONDAY_CLIENT_SECRET_GETSIGN = "getsign-secret";

export {};

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok    ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`);
  }
}

const b64 = (o: unknown) =>
  Buffer.from(JSON.stringify(o)).toString("base64url");

function mint(
  payload: Record<string, unknown>,
  secret: string,
  header: Record<string, unknown> = { alg: "HS256", typ: "JWT" },
): string {
  const signed = `${b64(header)}.${b64(payload)}`;
  const sig = crypto.createHmac("sha256", secret).update(signed).digest("base64url");
  return `${signed}.${sig}`;
}

const soon = Math.floor(Date.now() / 1000) + 300;
const dat = { account_id: 123456, user_id: 78910, slug: "acme", app_id: 55 };

async function main() {
  const { verifyMondaySessionToken } = await import("../lib/monday-session-token");

  console.log("\nA token monday really signed");
  {
  const claims = verifyMondaySessionToken(mint({ exp: soon, dat }, "vlookup-secret"));
  check("verifies", claims !== null);
  check("carries the account slug", claims?.accountSlug === "acme");
  check("carries the account and user ids", claims?.accountId === "123456" && claims?.userId === "78910");
  // The secret that verified it names the app — attribution nobody typed.
  check("names the app whose secret verified it", claims?.app === "vlookup");
  check(
    "…and the OTHER app's token resolves to that other app",
    verifyMondaySessionToken(mint({ exp: soon, dat }, "getsign-secret"))?.app === "getsign",
  );
  }

  console.log("\nEverything that must not pass");
  {
  check("a token signed with the wrong secret", verifyMondaySessionToken(mint({ exp: soon, dat }, "not-our-secret")) === null);
  check(
    "an app we hold no secret for",
    verifyMondaySessionToken(mint({ exp: soon, dat }, "trackmy-secret")) === null,
  );
  check(
    "an expired token — someone left the tab open",
    verifyMondaySessionToken(mint({ exp: Math.floor(Date.now() / 1000) - 1, dat }, "vlookup-secret")) === null,
  );
  // The classic JWT forgery: strip the signature and declare there isn't one.
  const none = `${b64({ alg: "none", typ: "JWT" })}.${b64({ exp: soon, dat })}.`;
  check("alg:none", verifyMondaySessionToken(none) === null);
  // A valid token with its payload swapped for someone else's account.
  const real = mint({ exp: soon, dat }, "vlookup-secret");
  const [h, , sig] = real.split(".");
  const swapped = `${h}.${b64({ exp: soon, dat: { ...dat, slug: "victim-corp" } })}.${sig}`;
  check("a tampered payload keeping the original signature", verifyMondaySessionToken(swapped) === null);
  check("a truncated token", verifyMondaySessionToken(real.slice(0, -6)) === null);
  check("rubbish", verifyMondaySessionToken("not.a.jwt") === null);
  check("nothing at all", verifyMondaySessionToken(undefined) === null && verifyMondaySessionToken("") === null);
  }

  console.log("\nA token with less in it than we hoped");
  {
  // monday documents account_id and user_id; slug is present in practice but
  // must not be assumed. A token without one still verifies — it just leaves
  // the slug unknown, which is honest rather than fatal.
  const claims = verifyMondaySessionToken(
    mint({ exp: soon, dat: { account_id: 1, user_id: 2 } }, "vlookup-secret"),
  );
  check("verifies without a slug", claims !== null && claims.accountSlug === undefined);
  check("and still names the app", claims?.app === "vlookup");
  }

  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
}

main();
