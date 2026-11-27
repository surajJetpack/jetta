/**
 * Feedback the team left for Jetta on the dev boards (lib/feedback.ts).
 *
 * Ratings of Jetta's chat replies (lib/chat-feedback.ts) and of the console
 * assistant's answers (lib/assistant-feedback.ts) live alongside them.
 *
 *   GET  → { feedback, chat, assistant }                         admins and CONSOLE_DEV_USERS
 *   POST { id, done: boolean, kind?: "chat" | "assistant" }      admin: mark one handled, or open again
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, requireDev } from "@/lib/roles";
import { adminActor } from "@/lib/auth";
import { listFeedback, setFeedbackDone } from "@/lib/feedback";
import { listAssistantFeedback, setAssistantFeedbackDone } from "@/lib/assistant-feedback";
import { listChatFeedback, setChatFeedbackDone } from "@/lib/chat-feedback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = requireDev(req);
  if (denied) return denied;
  const [feedback, chat, assistant] = await Promise.all([listFeedback(), listChatFeedback(), listAssistantFeedback()]);
  return NextResponse.json({ feedback, chat, assistant });
}

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as { id?: unknown; done?: unknown; kind?: unknown } | null;
  if (!body || typeof body.id !== "string" || typeof body.done !== "boolean") {
    return NextResponse.json({ error: "id and done are required" }, { status: 400 });
  }
  const by = adminActor(req) ?? "unknown";
  const entry =
    body.kind === "chat"
      ? await setChatFeedbackDone(body.id, body.done, by)
      : body.kind === "assistant"
        ? await setAssistantFeedbackDone(body.id, body.done, by)
        : await setFeedbackDone(body.id, body.done, by);
  if (!entry) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ entry });
}
