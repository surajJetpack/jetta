/**
 * Read and write JettaChat's settings.
 *
 * Admin-gated. Every write is audit-logged by the store, and a change to the
 * allowed origins is logged at warn level with the before/after list — that
 * field decides which sites may embed the chat, so it is a security control
 * wearing the same clothes as a colour picker.
 */
import { NextRequest, NextResponse } from "next/server";
import { adminActor, adminAuthorized } from "@/lib/auth";
import { getChatSettings, saveChatSettings, defaultSettings, type ChatSettings } from "@/lib/chat-settings";
import { config } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({
    settings: await getChatSettings(),
    // Shown beside each field so it is obvious what a value would fall back to,
    // and which switches live outside the console entirely.
    defaults: defaultSettings(),
    env: {
      live: config.jettachat.live,
      hasSecret: !!config.jettachat.secret,
      envOrigins: config.jettachat.allowedOrigins,
    },
  });
}

export async function POST(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const actor = adminActor(req) ?? "console";
  const patch = (await req.json().catch(() => null)) as Partial<ChatSettings> | null;
  if (!patch || typeof patch !== "object") {
    return NextResponse.json({ error: "expected a settings object" }, { status: 400 });
  }
  // updatedAt/updatedBy are stamped by the store; accepting them from the
  // client would let the audit trail be forged.
  delete patch.updatedAt;
  delete patch.updatedBy;
  return NextResponse.json({ settings: await saveChatSettings(patch, actor) });
}
