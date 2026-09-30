/**
 * Run one of the console assistant's lookups.
 *
 *   POST { name, args, callId? } → { result } | { error }
 *
 * The Live session asks for a tool; the browser relays it here, and only here
 * does it run — after the caller is re-checked as an admin. The browser is a
 * courier: it cannot run a data tool itself, and cannot reach one that was not
 * declared, because runConsoleTool only knows the read-only set.
 *
 * Every call is logged with who made it. A voice session has no transcript
 * anywhere else, so this is the record of what customer data was read out loud.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/roles";
import { adminActor } from "@/lib/auth";
import { logOpsEvent } from "@/lib/events";
import { runConsoleTool } from "@/lib/console-assistant";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const actor = adminActor(req) ?? "unknown";
  const body = (await req.json().catch(() => ({}))) as { name?: string; args?: unknown };
  if (typeof body.name !== "string") return NextResponse.json({ error: "name required" }, { status: 400 });

  const t0 = Date.now();
  try {
    const result = await runConsoleTool(body.name, body.args);
    await logOpsEvent({
      level: "info",
      event: "assistant.tool",
      source: "console",
      actor,
      data: { tool: body.name, args: JSON.stringify(body.args ?? {}).slice(0, 300), ms: Date.now() - t0 },
    });
    return NextResponse.json({ result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await logOpsEvent({
      level: "warn",
      event: "assistant.tool_failed",
      source: "console",
      actor,
      data: { tool: body.name, message: message.slice(0, 300) },
    });
    // 200 with an error body: the model should hear "that lookup failed" and
    // say so, rather than the session stalling on a relay error.
    return NextResponse.json({ error: message });
  }
}
