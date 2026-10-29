/**
 * Does a chat find the tickets its monday account already has — and only
 * when a monday app view vouches for the account?
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

const visitor = (name: string, slug: string) => ({ name, email: `${name}@x.com`, mondayAccountSlug: slug, app: "getsign" }) as never;

(async () => {
  console.log("Tickets per monday account");
  const first = await store.createConversation({ surface: "monday", visitor: visitor("pat", "acme") });
  await store.appendMessage(first.id, "visitor", "template won't open");
  await store.updateConversation(first.id, { ticketId: "14652" });
  const older = await store.createConversation({ surface: "monday", visitor: visitor("sam", "Acme") });
  await store.appendMessage(older.id, "visitor", "billing");
  await store.updateConversation(older.id, { ticketId: "14100" });

  const ids = await store.accountTicketIds("acme");
  check("a ticket opened from the in-app view is found by account", ids.includes("14652"));
  check("…case-insensitively, newest first", ids.join(",") === "14652,14100", ids.join(","));

  const link = await store.createConversation({ surface: "wordpress", visitor: visitor("mallory", "acme") });
  await store.appendMessage(link.id, "visitor", "hi");
  await store.updateConversation(link.id, { ticketId: "14999" });
  check("a support link's unproven slug is NOT indexed", !(await store.accountTicketIds("acme")).includes("14999"));
  check("trustedSlug: in-app view yes, editable link no", !!store.trustedSlug(first) && !store.trustedSlug(link));
  check("other accounts see nothing", (await store.accountTicketIds("someoneelse")).length === 0);

  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})();
