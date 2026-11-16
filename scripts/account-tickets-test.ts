/**
 * Does a chat find the tickets its monday account already has — and only
 * when monday itself (a verified session token) vouches for the account?
 *
 *   npx tsx scripts/account-tickets-test.ts
 *
 * In-memory store (no KV env), no network.
 */
import * as store from "../lib/chat-store";

export {};

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok    ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`);
  }
}

const visitor = (name: string, slug: string, verified = false) =>
  ({ name, email: `${name}@x.com`, mondayAccountSlug: slug, app: "getsign", ...(verified ? { mondayAccountVerified: true } : {}) }) as never;

(async () => {
  console.log("Tickets per monday account");
  const first = await store.createConversation({ surface: "monday", visitor: visitor("pat", "acme", true) });
  await store.appendMessage(first.id, "visitor", "template won't open");
  await store.updateConversation(first.id, { ticketId: "14652" });
  const older = await store.createConversation({ surface: "monday", visitor: visitor("sam", "Acme", true) });
  await store.appendMessage(older.id, "visitor", "billing");
  await store.updateConversation(older.id, { ticketId: "14100" });

  const ids = await store.accountTicketIds("acme");
  check("a ticket opened under a verified account is found by account", ids.includes("14652"));
  check("…case-insensitively, newest first", ids.join(",") === "14652,14100", ids.join(","));

  const link = await store.createConversation({ surface: "wordpress", visitor: visitor("mallory", "acme") });
  await store.appendMessage(link.id, "visitor", "hi");
  await store.updateConversation(link.id, { ticketId: "14999" });
  check("a support link's unproven slug is NOT indexed", !(await store.accountTicketIds("acme")).includes("14999"));
  // `surface: "monday"` is a field in the request like any other: an in-app
  // view that sent no session token is exactly as proven as a link.
  const unsigned = await store.createConversation({ surface: "monday", visitor: visitor("eve", "acme") });
  await store.appendMessage(unsigned.id, "visitor", "hi");
  await store.updateConversation(unsigned.id, { ticketId: "15001" });
  check("an unsigned in-app claim is NOT indexed either", !(await store.accountTicketIds("acme")).includes("15001"));
  check(
    "trustedSlug: verified yes; editable link and unsigned app view no",
    !!store.trustedSlug(first) && !store.trustedSlug(link) && !store.trustedSlug(unsigned),
  );
  check("other accounts see nothing", (await store.accountTicketIds("someoneelse")).length === 0);

  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})();
