/**
 * Serve a visitor's attachment back — to the visitor who sent it, or to us.
 *
 * These files are private in blob storage and reachable only through here,
 * because a support screenshot is a picture of somebody's account. Two ways in
 * and no third:
 *
 *   - the conversation token, as a query parameter, because an `<img src>`
 *     cannot send a header (the SSE stream already works this way)
 *   - a console session cookie, for the inbox
 *
 * The path carries the conversation id, so ownership is checked against the
 * URL itself: a valid token for conversation A cannot fetch a file stored
 * under conversation B.
 */
import { NextRequest, NextResponse } from "next/server";
import { verifySession, SESSION_COOKIE } from "@/lib/console-auth";
import { config } from "@/lib/config";
import { readFile, pathBelongsTo } from "@/lib/chat-files";
import * as store from "@/lib/chat-store";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ c: string; id: string; name: string }> },
) {
  const { c, id, name } = await params;

  const token = req.nextUrl.searchParams.get("token");
  const consoleUser = verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  // Dev-open console (no users and no admin secret configured) matches the
  // rule the admin APIs already use, so a local run isn't locked out of its
  // own screenshots.
  const devOpen = !config.consoleUsers && !config.adminSecret;
  if (!store.verifyToken(c, token) && !consoleUser && !devOpen) {
    return new NextResponse("Not authorized", { status: 403 });
  }

  const pathname = `chat/${c}/${id}/${name}`;
  // Belt and braces: the path is built from the URL, so this can only fail if
  // the segments contain something that escapes the prefix.
  if (!pathBelongsTo(pathname, c) || name.includes("/") || name.includes("..")) {
    return new NextResponse("Not found", { status: 404 });
  }

  const file = await readFile(pathname);
  if (!file) return new NextResponse("Not found", { status: 404 });

  return new NextResponse(file.stream, {
    headers: {
      "Content-Type": file.contentType,
      "Content-Length": String(file.size),
      // Inline so a screenshot renders in the transcript, with nosniff so the
      // browser cannot be talked into treating it as anything but the type we
      // identified from its own bytes.
      "Content-Disposition": `inline; filename="${name.replace(/"/g, "")}"`,
      "X-Content-Type-Options": "nosniff",
      // Private: this URL is per-visitor and must never land in a shared cache.
      "Cache-Control": "private, max-age=3600",
    },
  });
}
