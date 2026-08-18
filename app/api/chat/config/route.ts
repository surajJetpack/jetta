/**
 * The widget's own settings, before any conversation exists.
 *
 * Unauthenticated by necessity — a visitor loading a marketing page has no
 * token yet, and the widget needs its title, greeting and colour to render at
 * all. `publicSettings()` is what keeps that safe: it returns a named subset,
 * so origins, rate limits and retention cannot leak by someone later adding a
 * field to the wrong half of the settings object.
 *
 * Deliberately does NOT run channelUnavailable: a disabled channel still
 * answers here with `enabled: false`, so the widget can stay quiet instead of
 * rendering a launcher that fails the moment anyone clicks it.
 */
import { NextRequest } from "next/server";
import { chatJson, preflight } from "@/lib/chat-http";
import { getChatSettings, publicSettings } from "@/lib/chat-settings";
import { profileByKey, profileForOrigin } from "@/lib/profiles";
import { config } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(req: NextRequest) {
  return preflight(req);
}

export async function GET(req: NextRequest) {
  const settings = await getChatSettings();
  // Which brand the visitor is looking at. The embedding origin decides, so an
  // old install snippet still gets the right skin; ?product= lets a page that
  // knows better (a monday app view) say so explicitly.
  const profile =
    req.nextUrl.searchParams.get("product") === "getsign"
      ? profileByKey("getsign")
      : profileForOrigin(req.headers.get("origin"));
  return chatJson(req, {
    enabled: config.jettachat.live && settings.enabled,
    ...publicSettings(settings, profile.key),
  });
}
