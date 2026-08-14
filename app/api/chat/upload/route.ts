/**
 * Accept one file from a visitor.
 *
 * Uploading does not send anything — it parks the file against the
 * conversation and returns an id. The visitor then sends a normal message
 * naming that id, so a screenshot and the sentence explaining it arrive as one
 * turn instead of two, and the agent answers the whole thought.
 *
 * The same three guards as every public chat route (kill switch, conversation
 * token, rate limit), plus the file checks in lib/chat-files.ts.
 */
import { NextRequest } from "next/server";
import { channelUnavailable, chatJson, overRateLimit, preflight } from "@/lib/chat-http";
import { getChatSettings } from "@/lib/chat-settings";
import { storeUpload } from "@/lib/chat-files";
import { logOpsEvent } from "@/lib/events";
import * as store from "@/lib/chat-store";

export const runtime = "nodejs";
// A phone photo over a hotel wifi, plus the vision call. Well under the
// platform default, but the upload path deserves the headroom explicitly.
export const maxDuration = 120;

export async function OPTIONS(req: NextRequest) {
  return await preflight(req);
}

export async function POST(req: NextRequest) {
  const blocked = await channelUnavailable(req);
  if (blocked) return blocked;

  const settings = await getChatSettings();
  if (!settings.attachmentsEnabled) {
    return await chatJson(req, { error: "attachments are turned off" }, { status: 403 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return await chatJson(req, { error: "expected a file upload" }, { status: 400 });
  }

  const conversationId = String(form.get("conversationId") ?? "");
  const token = String(form.get("token") ?? "");
  if (!conversationId || !store.verifyToken(conversationId, token)) {
    return await chatJson(req, { error: "invalid token" }, { status: 403 });
  }

  // The conversation must still exist: an upload against an expired one would
  // bill us for a blob nobody can ever read.
  const conv = await store.getConversation(conversationId);
  if (!conv) return await chatJson(req, { expired: true }, { status: 410 });

  // Uploads count against the same per-IP budget as messages. A file is more
  // expensive than a message, so it is deliberately not given its own
  // allowance on top.
  if (await overRateLimit(req)) {
    await logOpsEvent({
      level: "warn",
      event: "chat.rate_limited",
      source: "jettachat",
      ticketId: conversationId,
      data: { on: "upload" },
    });
    return await chatJson(req, { error: "too many uploads, please slow down" }, { status: 429 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return await chatJson(req, { error: "no file received" }, { status: 400 });
  }

  const result = await storeUpload(conversationId, file, settings.maxAttachmentMb * 1024 * 1024);
  if (!result.ok) {
    return await chatJson(req, { error: result.error }, { status: result.status });
  }

  // The description stays server-side. It is prompt text the model will trust,
  // so it never travels through the browser where it could come back edited.
  const { id, name, contentType, size, width, height } = result.attachment;
  return await chatJson(req, { upload: { id, name, contentType, size, width, height } });
}
