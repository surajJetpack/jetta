/**
 * Attachment path checks that don't need credentials.
 *
 * Two things here are worth testing rather than eyeballing: the type sniffing
 * (a security control — it decides what we will serve back from our own
 * origin) and the Freshdesk multipart body (invisible until it fails in
 * production, on the one ticket where the screenshot mattered).
 *
 *   npx tsx scripts/chat-attachment-test.ts
 */
import type { ChatAttachment } from "../lib/types";

// lib/config.ts snapshots the environment when it is first imported, and
// createTicket's multipart branch only runs when Freshdesk is "live". So the
// env is set here and every module is imported dynamically below — a static
// import at the top of the file would load config first and pin it to stub
// mode, which is exactly the branch this script is not testing.
process.env.STUB_MODE = "false";
process.env.FRESHDESK_LIVE = "true";
process.env.FRESHDESK_DOMAIN = "test.freshdesk.com";
process.env.FRESHDESK_API_KEY = "test-key";

let failures = 0;
function check(name: string, pass: boolean, detail?: string) {
  console.log(`${pass ? "  ok  " : "FAIL  "}${name}${detail && !pass ? ` — ${detail}` : ""}`);
  if (!pass) failures++;
}

const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(16).fill(0)]).buffer;

async function main() {
const { sniffType, safeFileName, attachmentLine, textWithAttachments } = await import("../lib/chat-files");

// ── Type sniffing ────────────────────────────────────────────────
console.log("\nType sniffing");
check("PNG recognised", sniffType(bytes(0x89, 0x50, 0x4e, 0x47))?.type === "image/png");
check("JPEG recognised", sniffType(bytes(0xff, 0xd8, 0xff))?.type === "image/jpeg");
check("GIF recognised", sniffType(bytes(0x47, 0x49, 0x46))?.type === "image/gif");
check(
  "WebP recognised",
  sniffType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0, 0, 0]).buffer)
    ?.type === "image/webp",
);
check("PDF recognised", sniffType(bytes(0x25, 0x50, 0x44, 0x46))?.type === "application/pdf");
// The one that matters: a script file wearing an image's name.
check(
  "HTML rejected however it is labelled",
  sniffType(new TextEncoder().encode("<html><script>alert(1)</script>").buffer as ArrayBuffer) === null,
);
check("SVG rejected (it is a script container)", sniffType(new TextEncoder().encode("<svg xmlns=...>").buffer as ArrayBuffer) === null);
check("Truncated file rejected", sniffType(new Uint8Array([0x89, 0x50]).buffer) === null);

// ── Filenames ────────────────────────────────────────────────────
console.log("\nFilenames");
check("Path traversal stripped", !safeFileName("../../etc/passwd", "png").includes("/"));
check("Quotes stripped (Content-Disposition)", !safeFileName('scr"een.png', "png").includes('"'));
check("Extension follows the SNIFFED type", safeFileName("invoice.pdf", "png") === "invoice.png");
check("Nameless file still gets a name", safeFileName("", "png") === "upload.png");
check("Long name truncated", safeFileName("x".repeat(200), "png").length <= 64);

// ── How an attachment reads to the model ─────────────────────────
console.log("\nPrompt rendering");
const withDesc: ChatAttachment = {
  id: "1",
  name: "screenshot.png",
  contentType: "image/png",
  size: 1000,
  pathname: "chat/c/1/screenshot.png",
  description: 'Red banner reading "Error 402: Seat limit reached".',
};
const noDesc: ChatAttachment = { ...withDesc, id: "2", description: undefined };
check("Described image is marked as second-hand", attachmentLine(withDesc).includes("described from the image"));
check("Undescribed image says so", attachmentLine(noDesc).includes("not readable by me"));
check("PDF labelled as a PDF", attachmentLine({ ...noDesc, contentType: "application/pdf" }).startsWith("[PDF"));
check(
  "Caption and attachment travel together",
  textWithAttachments("why cant I save this?", [withDesc]).split("\n").length === 2,
);
check("No attachments leaves the text alone", textWithAttachments("hello", []) === "hello");

// ── Freshdesk multipart body ─────────────────────────────────────
// createTicket's multipart branch runs only when files are present, and only
// against the live API. Intercepting fetch is the only way to see the body it
// would actually send.
console.log("\nFreshdesk multipart");

const realFetch = globalThis.fetch;
let captured: FormData | null = null;
let capturedHeaders: Record<string, string> = {};
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  captured = init?.body as FormData;
  capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
  return new Response(JSON.stringify({ id: 4242 }), { status: 200 });
}) as typeof fetch;

const { createTicket } = await import("../lib/tools/freshdesk");
const created = await createTicket({
  subject: "Cannot save mapping",
  description: "Customer hit a seat limit.",
  email: "priya@example.com",
  name: "Priya Raman",
  productHint: "vlookup",
  source: 7,
  attachments: [
    { name: "screenshot.png", contentType: "image/png", data: new Uint8Array([1, 2, 3]).buffer },
  ],
});
globalThis.fetch = realFetch;

const form = captured as FormData | null;
check("Ticket created", created.id === "4242");
check("Body is multipart FormData", form instanceof FormData);
check("File part present", form?.get("attachments[]") instanceof Blob);
check("File keeps its name", (form?.get("attachments[]") as File | null)?.name === "screenshot.png");
check("Scalar fields flattened", form?.get("subject") === "Cannot save mapping");
check(
  "Nested custom_fields use bracket keys",
  form?.get("custom_fields[cf_product]") != null,
  `got keys: ${form ? [...form.keys()].join(",") : "none"}`,
);
// The classic multipart mistake: setting Content-Type by hand kills the boundary.
check("No hand-written Content-Type", !Object.keys(capturedHeaders).some((h) => h.toLowerCase() === "content-type"));
check("Authorization still sent", !!capturedHeaders.Authorization);

}

void main().then(() => {
  console.log(failures ? `\n${failures} failing\n` : "\nAll checks passed\n");
  process.exit(failures ? 1 : 0);
});
