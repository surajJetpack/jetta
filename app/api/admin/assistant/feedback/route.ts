/**
 * Rate one of the console assistant's answers (lib/assistant-feedback.ts).
 *
 *   POST   { id, rating, reasons?, note?, question, answer, steps?, path?, via? }
 *   DELETE { id }      take your own rating back
 *
 * Anyone who may use the assistant may rate it. Reading the ratings is on
 * /api/admin/feedback, with the rest of the feedback.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAssistant } from "@/lib/roles";
import { adminActor } from "@/lib/auth";
import { logOpsEvent } from "@/lib/events";
import { deleteAssistantFeedback, parseAssistantFeedback, saveAssistantFeedback } from "@/lib/assistant-feedback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const denied = requireAssistant(req);
  if (denied) return denied;
  const actor = adminActor(req) ?? "unknown";
  const parsed = parseAssistantFeedback(await req.json().catch(() => null), actor);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  await saveAssistantFeedback(parsed.entry);
  await logOpsEvent({
    level: "info",
    event: "assistant.feedback",
    source: "console",
    actor,
    data: { rating: parsed.entry.rating, reasons: parsed.entry.reasons.join(",") },
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const denied = requireAssistant(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as { id?: unknown } | null;
  if (!body || typeof body.id !== "string") return NextResponse.json({ error: "id required" }, { status: 400 });
  const ok = await deleteAssistantFeedback(body.id, adminActor(req) ?? "unknown");
  return NextResponse.json({ ok });
}
