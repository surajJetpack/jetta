/**
 * monday board webhooks → /activity, and → the dev bridge. Registered by
 * registerMondayWebhooks (lib/activity-push.ts) for comments, column changes,
 * new items and moves on the two dev boards.
 *
 * monday signs only app-made webhooks, so the shared WEBHOOK_SECRET rides in
 * the URL (?k=). The registration handshake is a POST with { challenge } that
 * must be echoed back.
 */
import { NextRequest, NextResponse, after } from "next/server";
import { config } from "@/lib/config";
import { safeEqual } from "@/lib/console-auth";
import { handleMondayWebhook } from "@/lib/activity-push";
import { handleDevBoardEvent } from "@/lib/dev-bridge";
import type { MondayWebhookEvent } from "@/lib/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A dev-bridge event runs a full ticket turn after the ACK.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("k") ?? "";
  if (!config.webhook.secret || !safeEqual(key, config.webhook.secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { challenge?: string; event?: MondayWebhookEvent; requeued?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (body.challenge) return NextResponse.json({ challenge: body.challenge });
  // Acknowledge whatever happens: monday retries a failed delivery for 30
  // minutes, and a row we can't parse will not parse better on retry.
  const event = body.event;
  // A dev-bridge event that waited for a run on the same item to finish
  // (lib/dev-bridge.ts). /activity recorded it when monday first sent it.
  if (event && body.requeued) {
    if (config.devBridge !== "off") after(() => handleDevBoardEvent(event, { requeued: true }));
    return NextResponse.json({ ok: true });
  }
  if (event) {
    await handleMondayWebhook(event).catch((e) => console.warn("monday activity webhook:", e));
    // After the ACK: a ticket run takes a minute, monday's delivery does not wait.
    // Runs after /activity has named the user, so the bridge can too.
    if (config.devBridge !== "off" || config.devKb !== "off") after(() => handleDevBoardEvent(event));
  }
  return NextResponse.json({ ok: true });
}
