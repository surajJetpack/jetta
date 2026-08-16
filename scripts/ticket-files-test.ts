/**
 * Tests for handing a ticket's files to a colleague in Slack.
 *
 *   npx tsx --env-file=.env.local scripts/ticket-files-test.ts
 *   SLACK_TEST_CHANNEL=C0123456 npx tsx --env-file=.env.local scripts/ticket-files-test.ts
 *
 * The Freshdesk half is read-only and always runs. The Slack half POSTS FILES
 * into a real conversation, so it only runs when SLACK_TEST_CHANNEL names one —
 * a test must not put customer screenshots somewhere nobody asked for.
 *
 * Fixtures: #13943 has three PNG attachments; #13944 has three screenshots
 * pasted into the body and no attachments at all.
 */
import { downloadTicketFiles, listTicketAttachments } from "../lib/tools/freshdesk";
import { uploadFiles } from "../lib/tools/slack";
import { config } from "../lib/config";

let failures = 0;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`);
  }
}

async function fetching() {
  console.log("── fetching a ticket's files ──");

  const all = await listTicketAttachments("13943");
  check(`#13943 has attachments to fetch (${all.length})`, all.length > 0);
  if (!all.length) return;

  await wait(400);
  const one = await downloadTicketFiles("13943", { wanted: [all[0].name] });
  check("a file asked for by name comes back", one.files.length === 1);
  check("…with its bytes, not just its metadata", (one.files[0]?.data.byteLength ?? 0) > 0);
  check(
    "…and the byte count matches what Freshdesk advertised",
    one.files[0]?.data.byteLength === all[0].size,
    `${one.files[0]?.data.byteLength} vs ${all[0].size}`,
  );

  await wait(400);
  const byId = await downloadTicketFiles("13943", { wanted: [all[0].id] });
  check("the same file can be asked for by id", byId.files[0]?.name === all[0].name);

  await wait(400);
  const messy = await downloadTicketFiles("13943", { wanted: [`  ${all[0].name.toUpperCase()} `] });
  // The name makes a round trip through a model that rendered it into a Slack
  // message; it does not always come back with its original case and spacing.
  check("case and stray whitespace do not lose the file", messy.files.length === 1);

  await wait(400);
  const wrong = await downloadTicketFiles("13943", { wanted: ["not-a-real-file.png"] });
  check("a name that matches nothing is reported, not ignored", wrong.skipped.length === 1);
  check("…with a reason a person can act on", /no attachment/.test(wrong.skipped[0]?.reason ?? ""));
  check("…and nothing is sent in its place", wrong.files.length === 0);

  await wait(400);
  const everything = await downloadTicketFiles("13943");
  check(`omitting names fetches all of them (${everything.files.length})`, everything.files.length === all.length);

  await wait(400);
  const pastedOff = await downloadTicketFiles("13944");
  check("#13944 has no attachments, so nothing comes back by default", pastedOff.files.length === 0);

  await wait(400);
  const pastedOn = await downloadTicketFiles("13944", { includePasted: true });
  // The only route to a pasted screenshot: it has no filename to ask for, and
  // it never appears in the attachments API.
  check(
    `pasted screenshots come back when asked for (${pastedOn.files.length})`,
    pastedOn.files.length > 0,
    pastedOn.files.map((f) => f.name).join(", "),
  );
  check(
    "…as real image bytes",
    pastedOn.files.every((f) => f.contentType.startsWith("image/") && f.data.byteLength > 1024),
  );
}

async function delivering() {
  console.log("\n── delivering into Slack ──");

  const channel = process.env.SLACK_TEST_CHANNEL;
  if (!channel) {
    console.log("  ..    SLACK_TEST_CHANNEL not set — skipping the upload (it posts real files).");
    // Still worth knowing before the first person asks for a file in anger.
    const res = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.slack.botToken}` },
    });
    const scopes = (res.headers.get("x-oauth-scopes") ?? "").split(",").map((s) => s.trim());
    if (scopes.includes("files:write")) {
      console.log("  ..    files:write IS granted — set SLACK_TEST_CHANNEL to test a real upload.");
    } else {
      console.log(
        "  PENDING  files:write is NOT granted. Uploads will fail until it is added in the Slack app config and the app is reinstalled.",
      );
    }
    return;
  }

  const { files } = await downloadTicketFiles("13943");
  check("there is something to send", files.length > 0);
  if (!files.length) return;

  const outcome = await uploadFiles(channel, undefined, files.slice(0, 2), "Test upload from ticket-files-test");
  const missingScope = outcome.failed.some((f) => /files:write/.test(f.reason));
  if (missingScope) {
    // Not a pass. But the failure is the one we designed for: named, actionable,
    // and impossible to mistake for success.
    console.log("  PENDING  files:write is not granted yet — upload refused, and said so clearly:");
    for (const f of outcome.failed) console.log(`             ${f.name} — ${f.reason}`);
    check("nothing was reported as uploaded", outcome.uploaded.length === 0);
    return;
  }
  check(`files landed in ${channel} (${outcome.uploaded.length})`, outcome.uploaded.length > 0);
  check("nothing failed silently", outcome.failed.length === 0, JSON.stringify(outcome.failed));
}

async function main() {
  if (!process.env.FRESHDESK_API_KEY) {
    console.log("No FRESHDESK_API_KEY — run with --env-file=.env.local.");
    process.exit(1);
  }
  await fetching();
  await delivering();
  console.log(failures ? `\n${failures} failed\n` : "\nall passed\n");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
