/**
 * KB drafts from the dev board (JETTA_DEV_KB).
 *
 * What a developer explains on an item is usually the only place that answer
 * is ever written down. Two ways it reaches the KB review queue:
 *
 *   - A Question item (ask_devs) that a developer answers: drafted straight
 *     from the question and the answer, once the answer has gone to the
 *     customer.
 *   - A bug item that reaches a finished status: Jetta asks its Developer,
 *     once, for a short explanation or a doc. Whatever they post next on the
 *     item — text, or a PDF / Word / text file on a new update — is drafted.
 *     "no KB" ends it.
 *
 * Drafts only, in the review queue (state "draft"), linked to the item by
 * meta.devItemId like the /dev-board page's drafts. One draft per item, ever.
 */
import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";
import { config } from "./config";
import { logOpsEvent } from "./events";
import { createArticle } from "./kb-store";
import { draftKbArticle } from "./knowledge-loop";
import { kvGet, kvSet, rememberJettaPost } from "./kv";
import * as monday from "./tools/monday";
import type { DevItemSnapshot, ItemFile } from "./tools/monday";

const askKey = (itemId: string) => `devbridge:kbask:${itemId}`;
const doneKey = (itemId: string) => `devbridge:kbdone:${itemId}`;

/** Finished statuses worth asking about. Not "Could not replicate" / "Archived": nothing to document. */
const KB_ASK_STATUS = /^(deployed to prod|test passed on prod|not an issue|not bug|not a bug)$/i;

/** "no kb", "No KB needed", "nothing for KB" … */
export function declinesKb(text: string): boolean {
  return /^\W*(no\s*kb|nothing\s+(for|needed for)\s+(the\s+)?kb|kb\s+not\s+needed)\b/i.test(text.trim());
}

export function shouldAskForKb(item: Pick<DevItemSnapshot, "type">, status: string): boolean {
  return KB_ASK_STATUS.test(status.trim()) && !/question/i.test(item.type ?? "") && !/feature/i.test(item.type ?? "");
}

export const KB_ASK_TEXT =
  'Thanks for closing this out. Is there anything customers should know: a how-to, a change in behaviour, or a workaround? Reply here with a short explanation, or post a doc (PDF, Word or text) as a new update on this item, and I\'ll draft a help-centre article for the team to review. Reply "no KB" if nothing\'s needed.';

const MAX_DOC_BYTES = 10 * 1024 * 1024;
const MAX_DOC_CHARS = 20_000;

/** The text of a file a developer posted, or null for a type we can't read. */
export async function docText(file: ItemFile): Promise<string | null> {
  if (file.size > MAX_DOC_BYTES || !/^(pdf|docx|txt|md|markdown|csv)$/.test(file.extension)) return null;
  const res = await fetch(file.url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  let text: string;
  if (file.extension === "pdf") {
    text = (await extractText(await getDocumentProxy(buf), { mergePages: true })).text;
  } else if (file.extension === "docx") {
    text = (await mammoth.extractRawText({ buffer: Buffer.from(buf) })).value;
  } else {
    text = new TextDecoder().decode(buf);
  }
  return text.replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_DOC_CHARS) || null;
}

/** The item's thread, oldest first, as draftKbArticle reads a Slack thread. */
async function threadOf(itemId: string): Promise<string> {
  const item = await monday.getItemUpdates(itemId, 30);
  if (!item) return "";
  return [...item.updates]
    .reverse()
    .flatMap((u) => [`${u.author}: ${u.text}`, ...u.replies.map((r) => `  ${r.author} (reply): ${r.text}`)])
    .join("\n\n");
}

/**
 * Draft one article from an item. In shadow, the draft is generated and
 * logged but not saved, so its quality can be judged before switching on.
 */
export async function draftFromItem(item: DevItemSnapshot, reason: string, docs: { name: string; text: string }[] = []): Promise<void> {
  const mode = config.devKb;
  if (mode === "off" || (await kvGet(doneKey(item.id)))) return;
  const thread = await threadOf(item.id);
  const attached = docs.map((d) => `\n\nDocument the developer attached ("${d.name}"):\n${d.text}`).join("");
  const draft = await draftKbArticle(`Dev board item: ${item.name}\n\n${thread}${attached}`);

  // The drafter says so when the thread holds no answer. A draft that only
  // restates the problem is noise in the review queue; leave the item open
  // for a later answer instead.
  if (noAnswer(draft)) {
    await logOpsEvent({ level: "info", event: "devbridge.kb_no_answer", source: "webhook", ticketId: item.ticketIds[0], data: { itemId: item.id, reason, title: draft.title } });
    return;
  }

  if (mode === "shadow") {
    await logOpsEvent({
      level: "info",
      event: "devbridge.kb_shadow",
      source: "webhook",
      ticketId: item.ticketIds[0],
      data: { itemId: item.id, reason, title: draft.title, body: draft.body.slice(0, 1500), docs: docs.map((d) => d.name) },
    });
    await kvSet(doneKey(item.id), "shadow", 365 * 24 * 3600);
    return;
  }

  const article = await createArticle({
    title: draft.title,
    body: draft.body,
    keywords: draft.keywords,
    tags: ["dev-board", item.product],
    state: "draft",
    origin: "knowledge-loop",
    source: "dev-board",
    product: item.product === "getsign" ? "getsign" : "jetpackapps",
    createdBy: "jetta:dev-bridge",
    meta: { devItemId: item.id },
  });
  await kvSet(doneKey(item.id), article.id, 365 * 24 * 3600);
  const posted = await monday.postJettaComment(
    item.id,
    `Drafted a help-centre article from this: "${article.title}". It's in the KB review queue${config.appUrl ? ` (${config.appUrl}/kb/review)` : ""} and goes live only once someone approves it.`,
  );
  if (posted) await rememberJettaPost(posted.id);
  await logOpsEvent({
    level: "info",
    event: "devbridge.kb_drafted",
    source: "webhook",
    ticketId: item.ticketIds[0],
    data: { itemId: item.id, articleId: article.id, reason, docs: docs.map((d) => d.name), duplicates: article.duplicates?.length ?? 0 },
  });
}

/** draftKbArticle's "resolution was not captured" verdict. Pure. */
export function noAnswer(draft: { title: string; body: string }): boolean {
  return /\b(not captured|no resolution|resolution (was )?not)\b/i.test(`${draft.title}\n${draft.body}`);
}

/** Ask a finished bug's Developer for a doc — once per item. */
export async function askForKb(item: DevItemSnapshot): Promise<void> {
  const mode = config.devKb;
  if (mode === "off" || (await kvGet(doneKey(item.id))) || (await kvGet(askKey(item.id)))) return;
  const at = new Date().toISOString();
  if (mode === "shadow") {
    await logOpsEvent({ level: "info", event: "devbridge.kb_shadow", source: "webhook", ticketId: item.ticketIds[0], data: { itemId: item.id, ask: true, to: item.developers.map((d) => d.name) } });
    await kvSet(askKey(item.id), at, 30 * 24 * 3600);
    return;
  }
  const posted = await monday.postJettaComment(item.id, KB_ASK_TEXT, { mentionUserIds: item.developers.map((d) => d.id) });
  if (!posted) return;
  await rememberJettaPost(posted.id);
  await kvSet(askKey(item.id), at, 30 * 24 * 3600);
  await logOpsEvent({ level: "info", event: "devbridge.kb_asked", source: "webhook", ticketId: item.ticketIds[0], data: { itemId: item.id } });
}

/**
 * Is a KB request open on this item? Returns when it was asked. Stored as a
 * bare ISO string: the Upstash client parses JSON values on read, so a JSON
 * object comes back as an object and a JSON.parse of it throws.
 */
export async function pendingKbAsk(itemId: string): Promise<string | null> {
  if (config.devKb === "off" || (await kvGet(doneKey(itemId)))) return null;
  const at = await kvGet(askKey(itemId));
  return at && !Number.isNaN(Date.parse(String(at))) ? String(at) : null;
}

/**
 * A person posted on an item with an open KB request: that is the answer.
 * "no KB" closes it; anything else (text and/or files) is drafted.
 */
export async function handleKbAnswer(item: DevItemSnapshot, text: string, askedAt: string, selfId: string | null): Promise<void> {
  if (declinesKb(text)) {
    await kvSet(doneKey(item.id), "declined", 365 * 24 * 3600);
    await logOpsEvent({ level: "info", event: "devbridge.kb_declined", source: "webhook", ticketId: item.ticketIds[0], data: { itemId: item.id } });
    return;
  }
  const docs: { name: string; text: string }[] = [];
  const unread: string[] = [];
  for (const file of (await monday.itemFilesSince(item.id, askedAt, selfId)).slice(0, 3)) {
    const t = await docText(file).catch(() => null);
    if (t) docs.push({ name: file.name, text: t });
    else unread.push(file.name);
  }
  if (!text.trim() && !docs.length) {
    // An image or a file type we can't read, and no words: nothing to draft from yet.
    await logOpsEvent({ level: "info", event: "devbridge.kb_unreadable", source: "webhook", ticketId: item.ticketIds[0], data: { itemId: item.id, files: unread } });
    return;
  }
  await draftFromItem(item, "developer answered the KB request", docs);
}
