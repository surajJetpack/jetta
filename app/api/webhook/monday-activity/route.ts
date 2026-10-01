/**
 * monday board webhooks → /activity. Registered by registerMondayWebhooks
 * (lib/activity-push.ts) for comments, column changes, new items and moves on
 * the two dev boards.
 *
 * monday signs only app-made webhooks, so the shared WEBHOOK_SECRET rides in
 * the URL (?k=). The registration handshake is a POST with { challenge } that
 * must be echoed back.
 */
import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { safeEqual } from "@/lib/console-auth";
import { handleMondayWebhook } from "@/lib/activity-push";
import type { MondayWebhookEvent } from "@/lib/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("k") ?? "";
  if (!config.webhook.secret || !safeEqual(key, config.webhook.secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { challenge?: string; event?: MondayWebhookEvent };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (body.challenge) return NextResponse.json({ challenge: body.challenge });
  // Acknowledge whatever happens: monday retries a failed delivery for 30
  // minutes, and a row we can't parse will not parse better on retry.
  if (body.event) await handleMondayWebhook(body.event).catch((e) => console.warn("monday activity webhook:", e));
  return NextResponse.json({ ok: true });
}
