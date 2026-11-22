/**
 * Feedback the team left for Jetta on the dev boards (lib/feedback.ts).
 *
 *   GET  → { feedback }                 admins and CONSOLE_DEV_USERS
 *   POST { id, done: boolean }          admin: mark one handled, or open again
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, requireDev } from "@/lib/roles";
import { adminActor } from "@/lib/auth";
import { listFeedback, setFeedbackDone } from "@/lib/feedback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = requireDev(req);
  if (denied) return denied;
  return NextResponse.json({ feedback: await listFeedback() });
}

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as { id?: unknown; done?: unknown } | null;
  if (!body || typeof body.id !== "string" || typeof body.done !== "boolean") {
    return NextResponse.json({ error: "id and done are required" }, { status: 400 });
  }
  const entry = await setFeedbackDone(body.id, body.done, adminActor(req) ?? "unknown");
  if (!entry) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ entry });
}
