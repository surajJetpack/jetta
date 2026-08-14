/**
 * Visitor file uploads for JettaChat.
 *
 * "It's doing this" and a screenshot is how support actually starts, and until
 * now this channel could only take the sentence. This module is the whole file
 * path: validate → store → describe → hand back a descriptor the rest of the
 * system can carry.
 *
 * Three decisions worth knowing about:
 *
 *   1. **Private blobs, served through our own route.** A screenshot of a
 *      support problem is a screenshot of someone's account — invoice numbers,
 *      email addresses, whatever else was on screen. A public blob URL is
 *      unguessable but permanently bearer-readable, so files go in private and
 *      `/api/chat/file/…` checks the conversation token (visitor) or the
 *      console session (us) on every read.
 *
 *   2. **The type is sniffed, not trusted.** `file.type` is whatever the
 *      browser was told. We read the magic bytes and serve back only the type
 *      WE identified, so a mislabelled upload can't turn into an HTML page
 *      served from our origin.
 *
 *   3. **A vision pass runs at upload time, and its words are stored.** The
 *      answering model (glm-5.2 in prod) is not reliably multimodal, and
 *      swapping it shouldn't silently blind Jetta to attachments. So one cheap
 *      light-tier call turns the image into text at the door, and every
 *      downstream consumer — the agent turn, the Freshdesk hand-off, the
 *      console — reads the same description. It is stored rather than
 *      recomputed because it becomes part of the transcript record: what Jetta
 *      answered has to be judgeable later against what she was told she saw.
 */
import crypto from "node:crypto";
import { put, get, del, list } from "@vercel/blob";
import { generateText } from "ai";
import { Redis } from "@upstash/redis";
import { config } from "./config";
import { getModel } from "./llm";
import { imageDimensions } from "./image-dims";
import { logOpsEvent } from "./events";
import type { ChatAttachment } from "./types";

let redis: Redis | null = null;
function client(): Redis | null {
  if (config.kv.url && config.kv.token) {
    redis ??= new Redis({ url: config.kv.url, token: config.kv.token });
    return redis;
  }
  return null;
}

/**
 * What a visitor may send. Images because that is the actual request, PDF
 * because invoices and signed documents are the GetSign version of it.
 *
 * Not video: a screen recording is a legitimate support artefact, but at
 * phone-camera sizes it would dominate both the upload path and the blob bill,
 * and neither the vision pass nor Freshdesk would do anything useful with it.
 * If people start asking, that is a deliberate follow-up, not an oversight.
 */
const SIGNATURES: { type: string; ext: string; test: (b: Uint8Array) => boolean }[] = [
  { type: "image/png", ext: "png", test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { type: "image/jpeg", ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: "image/gif", ext: "gif", test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 },
  {
    type: "image/webp",
    ext: "webp",
    test: (b) =>
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
  { type: "application/pdf", ext: "pdf", test: (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 },
];

/** The real type of these bytes, or null if it isn't something we accept. */
export function sniffType(data: ArrayBuffer): { type: string; ext: string } | null {
  const head = new Uint8Array(data.slice(0, 16));
  if (head.length < 12) return null;
  const hit = SIGNATURES.find((s) => s.test(head));
  return hit ? { type: hit.type, ext: hit.ext } : null;
}

export const ACCEPT_ATTRIBUTE = "image/png,image/jpeg,image/gif,image/webp,application/pdf";

/** Most files one visitor message may carry. */
export const MAX_FILES_PER_MESSAGE = 4;

/**
 * Filenames reach three places that all parse them differently (a blob
 * pathname, a Content-Disposition header, a Freshdesk multipart part), so they
 * are reduced to something none of them can misread rather than escaped three
 * ways.
 */
export function safeFileName(name: string, ext: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "file")
    .replace(/\.[^.]*$/, "")
    .replace(/[^a-zA-Z0-9 ._-]/g, "")
    .trim()
    .slice(0, 60);
  return `${base || "upload"}.${ext}`;
}

// ── Pending uploads ────────────────────────────────────────────────

/**
 * An uploaded file waits here until the visitor actually sends the message it
 * is attached to.
 *
 * The descriptor deliberately does NOT round-trip through the browser: the
 * send request names upload ids, and the server rehydrates the real record
 * from this key. Otherwise a visitor could hand back an edited descriptor and
 * write their own "description" of the image straight into the prompt Jetta
 * reads — a text field the model trusts, supplied by the person it is talking
 * to.
 */
const pendingKey = (conversationId: string, uploadId: string) =>
  `jetta:chat:upload:${conversationId}:${uploadId}`;

/** An hour: long enough to attach a file and keep typing, short enough to expire abandoned ones. */
const PENDING_TTL = 3600;

const memPending = new Map<string, { value: ChatAttachment; expiresAt: number }>();

async function putPending(conversationId: string, att: ChatAttachment): Promise<void> {
  const key = pendingKey(conversationId, att.id);
  const r = client();
  if (r) {
    await r.set(key, att, { ex: PENDING_TTL });
    return;
  }
  memPending.set(key, { value: att, expiresAt: Date.now() + PENDING_TTL * 1000 });
}

/**
 * Claim uploads for a message being sent. Unknown or already-claimed ids are
 * dropped rather than erroring: the message itself matters more than a file
 * that expired while the visitor was typing.
 */
export async function claimPending(
  conversationId: string,
  uploadIds: string[],
): Promise<ChatAttachment[]> {
  const out: ChatAttachment[] = [];
  for (const id of uploadIds.slice(0, MAX_FILES_PER_MESSAGE)) {
    if (!/^[a-z0-9-]{6,64}$/i.test(id)) continue;
    const key = pendingKey(conversationId, id);
    const r = client();
    if (r) {
      const hit = await r.get<ChatAttachment>(key);
      if (hit) {
        out.push(hit);
        await r.del(key);
      }
      continue;
    }
    const mem = memPending.get(key);
    if (mem && mem.expiresAt > Date.now()) {
      out.push(mem.value);
      memPending.delete(key);
    }
  }
  return out;
}

// ── Upload ─────────────────────────────────────────────────────────

export interface UploadResult {
  ok: true;
  attachment: ChatAttachment;
}
export interface UploadRejected {
  ok: false;
  /** Shown to the visitor verbatim, so it says what to do next. */
  error: string;
  status: number;
}

/**
 * Validate, store, and describe one uploaded file.
 *
 * `maxBytes` comes from console settings so the ceiling can be lowered without
 * a deploy if someone starts posting 20 MB phone photos.
 */
export async function storeUpload(
  conversationId: string,
  file: File,
  maxBytes: number,
): Promise<UploadResult | UploadRejected> {
  if (file.size === 0) return { ok: false, error: "That file is empty.", status: 400 };
  if (file.size > maxBytes) {
    return {
      ok: false,
      error: `That file is too large (max ${Math.round(maxBytes / (1024 * 1024))} MB).`,
      status: 413,
    };
  }

  const data = await file.arrayBuffer();
  const sniffed = sniffType(data);
  if (!sniffed) {
    return {
      ok: false,
      error: "I can only take images (PNG, JPG, GIF, WebP) or a PDF.",
      status: 415,
    };
  }

  const id = crypto.randomUUID();
  const name = safeFileName(file.name || "upload", sniffed.ext);
  // Conversation id in the path is what makes an ownership check possible at
  // read time without a second lookup.
  const pathname = `chat/${conversationId}/${id}/${name}`;

  if (!config.blob.token) {
    return {
      ok: false,
      error: "Attachments aren't set up right now — describe the problem and I'll help from there.",
      status: 503,
    };
  }

  await put(pathname, data, {
    access: "private",
    contentType: sniffed.type,
    // We generate the id; a second random suffix would only make the pathname
    // unguessable-but-unpredictable, and we need to be able to rebuild it.
    addRandomSuffix: false,
    token: config.blob.token,
  });

  const dims = sniffed.type.startsWith("image/") ? imageDimensions(data) : null;
  const attachment: ChatAttachment = {
    id,
    name,
    contentType: sniffed.type,
    size: file.size,
    pathname,
    ...(dims ? { width: dims.width, height: dims.height } : {}),
  };

  // Describe before returning, not in the background: the visitor's next
  // message can arrive within the debounce window, and an attachment the agent
  // turn can't read yet is worse than a slightly slower upload.
  attachment.description = await describeAttachment(attachment, data);

  await putPending(conversationId, attachment);
  await logOpsEvent({
    level: "info",
    event: "chat.attachment_uploaded",
    source: "jettachat",
    ticketId: conversationId,
    data: {
      contentType: attachment.contentType,
      size: attachment.size,
      described: !!attachment.description,
    },
  });
  return { ok: true, attachment };
}

// ── Reading back ───────────────────────────────────────────────────

/** True when this pathname belongs to this conversation. */
export function pathBelongsTo(pathname: string, conversationId: string): boolean {
  return pathname.startsWith(`chat/${conversationId}/`);
}

export interface FetchedFile {
  stream: ReadableStream<Uint8Array>;
  contentType: string;
  size: number;
}

/** Stream a stored file back. Returns null when it has expired or never existed. */
export async function readFile(pathname: string): Promise<FetchedFile | null> {
  if (!config.blob.token) return null;
  try {
    const res = await get(pathname, { access: "private", token: config.blob.token });
    if (!res || res.statusCode !== 200) return null;
    return { stream: res.stream, contentType: res.blob.contentType, size: res.blob.size };
  } catch (e) {
    console.warn(`chat file read failed for ${pathname}:`, e instanceof Error ? e.message : e);
    return null;
  }
}

/** Bytes rather than a stream — for forwarding into Freshdesk. */
export async function readFileBytes(pathname: string): Promise<ArrayBuffer | null> {
  const file = await readFile(pathname);
  if (!file) return null;
  return await new Response(file.stream).arrayBuffer();
}

/** Delete a conversation's files. Best-effort: a leaked blob is not worth an error. */
export async function deleteFiles(pathnames: string[]): Promise<void> {
  if (!config.blob.token || !pathnames.length) return;
  await del(pathnames, { token: config.blob.token }).catch((e) =>
    console.warn("chat file delete failed:", e instanceof Error ? e.message : e),
  );
}

// ── Vision ─────────────────────────────────────────────────────────

/**
 * The prompt is written for the one thing screenshots are actually sent for:
 * the error on the screen. Verbatim transcription matters more than prose —
 * "Error 402: seat limit reached" is the answer, and a description that says
 * "an error dialog" has thrown the answer away.
 */
const VISION_PROMPT = [
  "This image was sent by a customer to a support agent. Describe it for the agent, who cannot see it.",
  "",
  "Rules:",
  "- Transcribe any error message, code, or warning text EXACTLY as it appears, in quotes.",
  "- Name the product screen or page if you can tell (a spreadsheet, a settings page, a signing request, an invoice).",
  "- Say what state things are in: what is filled in, what is empty, what is highlighted or red.",
  "- Do not speculate about the cause and do not suggest a fix. Describe only.",
  "- 3 sentences at most. If the image is blank, decorative, or unreadable, say exactly that.",
].join("\n");

/** Longest description we keep — it rides in the prompt on every turn afterwards. */
const DESCRIPTION_MAX = 600;

/**
 * Turn an image into words. Returns undefined when it can't — a missing
 * description degrades Jetta to "I can see you've attached a file", which is
 * honest, where a failed upload would be a dead end.
 */
export async function describeAttachment(
  attachment: ChatAttachment,
  data: ArrayBuffer,
): Promise<string | undefined> {
  // PDFs are out of scope for the vision pass: the useful ones are multi-page
  // invoices where a page-1 summary would mislead more than it helps. They
  // still upload, still reach the console, and still ride onto the ticket.
  if (!attachment.contentType.startsWith("image/")) return undefined;

  try {
    const { text } = await generateText({
      // Light tier: this is a transcription job, and it runs on every upload.
      model: getModel("light"),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: VISION_PROMPT },
            { type: "image", image: data, mediaType: attachment.contentType },
          ],
        },
      ],
      maxOutputTokens: 300,
    });
    const clean = text.trim().replace(/\s+/g, " ");
    return clean ? clean.slice(0, DESCRIPTION_MAX) : undefined;
  } catch (e) {
    // The commonest cause is a light-tier model without vision. Loud in the
    // ops log, silent to the visitor.
    console.warn("attachment description failed:", e instanceof Error ? e.message : e);
    await logOpsEvent({
      level: "warn",
      event: "chat.attachment_vision_failed",
      source: "jettachat",
      data: { error: e instanceof Error ? e.message : String(e) },
    }).catch(() => {});
    return undefined;
  }
}

// ── Rendering into text ────────────────────────────────────────────

/**
 * How an attachment appears to the model and in the ticket transcript.
 *
 * Marked as a description rather than presented as the image itself, because
 * the difference matters when Jetta answers: she should say "from your
 * screenshot it looks like…" and be wrong-able, not claim to have seen
 * something she was told about.
 */
export function attachmentLine(a: ChatAttachment): string {
  const kind = a.contentType === "application/pdf" ? "PDF" : "Image";
  if (!a.description) return `[${kind} attached: ${a.name} — not readable by me]`;
  return `[${kind} attached: ${a.name} — described from the image: ${a.description}]`;
}

/** Message text plus any attachment lines, for prompts and transcripts. */
export function textWithAttachments(text: string, attachments?: ChatAttachment[]): string {
  if (!attachments?.length) return text;
  return [text.trim(), ...attachments.map(attachmentLine)].filter(Boolean).join("\n");
}

/**
 * Download a conversation's files so they can be attached to a Freshdesk
 * ticket. Best-effort per file: a screenshot that fails to download must not
 * stop the hand-off, because the hand-off is the thing the customer was
 * promised.
 */
export async function collectForHandoff(conv: {
  messages: { attachments?: ChatAttachment[] }[];
}): Promise<{ name: string; contentType: string; data: ArrayBuffer }[]> {
  const all = conv.messages.flatMap((m) => m.attachments ?? []);
  // Freshdesk's own ceilings: 20 MB per file, and a handful is plenty of
  // evidence for one ticket.
  const picked = all.filter((a) => a.size <= 20 * 1024 * 1024).slice(0, 5);
  const out: { name: string; contentType: string; data: ArrayBuffer }[] = [];
  for (const a of picked) {
    const data = await readFileBytes(a.pathname).catch(() => null);
    if (data) out.push({ name: a.name, contentType: a.contentType, data });
    else console.warn(`chat attachment ${a.pathname} could not be forwarded to Freshdesk.`);
  }
  return out;
}

// ── Retention ──────────────────────────────────────────────────────

/**
 * Delete attachments older than the retention window.
 *
 * Transcripts expire on their own — Redis holds them with a TTL — but blob
 * storage has no such thing, so without this the screenshots would outlive the
 * conversations they belong to and quietly become a permanent archive of
 * customer screens. Run daily from the overview cron.
 *
 * Age is measured from upload, not from last activity in the conversation. A
 * chat still running 90 days later would lose its oldest images; chats last
 * minutes, so this trades a case that does not happen for a rule that is
 * simple to reason about.
 */
export async function pruneExpiredFiles(retentionDays: number): Promise<{ deleted: number }> {
  if (!config.blob.token) return { deleted: 0 };
  const cutoff = Date.now() - Math.max(1, retentionDays) * 86400_000;
  let cursor: string | undefined;
  let deleted = 0;

  do {
    const page = await list({ prefix: "chat/", cursor, limit: 1000, token: config.blob.token });
    const stale = page.blobs.filter((b) => b.uploadedAt.getTime() < cutoff).map((b) => b.pathname);
    if (stale.length) {
      await deleteFiles(stale);
      deleted += stale.length;
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  if (deleted) {
    await logOpsEvent({
      level: "info",
      event: "chat.attachments_pruned",
      source: "cron",
      data: { deleted, retentionDays },
    }).catch(() => {});
  }
  return { deleted };
}
