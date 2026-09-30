/**
 * Start (or resume) a console voice session.
 *
 *   POST { pathname, mode: "live" | "deep", resumeHandle? }
 *     → { token, model, config }
 *
 * Mints a single-use Gemini ephemeral token with the model, instructions and
 * tool declarations LOCKED into it. The browser connects to Google with that
 * token and nothing else: it never sees the API key, and it cannot widen the
 * session — a client that sends its own system prompt or tool list has it
 * ignored by the API, because the constraint wins.
 *
 * The resume handle is baked into the constraint here rather than passed by the
 * browser at connect time, for the same reason: locked fields are not the
 * client's to set, including this one.
 *
 * Admin-only for now (decided 2026-09-30); read-only either way.
 */
import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI, Modality, type LiveConnectConfig } from "@google/genai";
import { requireAdmin } from "@/lib/roles";
import { adminActor } from "@/lib/auth";
import { config } from "@/lib/config";
import { logOpsEvent } from "@/lib/events";
import {
  LIVE_MODELS,
  buildInstructions,
  liveDeclarations,
  type AssistantMode,
} from "@/lib/console-assistant";

/** Google's own ceiling is a 10-minute connection; the token only has to outlive a resumed session or two. */
const TOKEN_TTL_MS = 30 * 60_000;
/** How long the browser has to open the socket after asking. */
const CONNECT_WINDOW_MS = 60_000;

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  if (!config.google.apiKey) {
    return NextResponse.json({ error: "no_key", message: "GOOGLE_GENERATIVE_AI_API_KEY is not set." }, { status: 503 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    pathname?: string;
    mode?: AssistantMode;
    resumeHandle?: string;
  };
  const mode: AssistantMode = body.mode === "deep" ? "deep" : "live";
  const pathname = typeof body.pathname === "string" && body.pathname.startsWith("/") ? body.pathname.slice(0, 200) : "/today";
  const user = adminActor(req) ?? "unknown";
  const model = LIVE_MODELS[mode];

  const liveConfig: LiveConnectConfig = {
    responseModalities: [Modality.AUDIO],
    systemInstruction: await buildInstructions({ user, pathname, mode }),
    tools: [{ functionDeclarations: liveDeclarations(mode) }],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    // Survives Google's ~10-minute connection resets (GoAway) without losing the thread.
    sessionResumption: body.resumeHandle ? { handle: body.resumeHandle } : {},
    // Without this an audio session is capped at 15 minutes of context.
    contextWindowCompression: { slidingWindow: {} },
    ...(process.env.JETTA_ASSISTANT_VOICE
      ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: process.env.JETTA_ASSISTANT_VOICE } } } }
      : {}),
    // The extended model requires a thinking level and rejects "minimal"; the
    // plain live model must not be given one at all.
    ...(mode === "deep" ? { thinkingConfig: { thinkingLevel: "LOW" as never } } : {}),
  };

  try {
    const ai = new GoogleGenAI({ apiKey: config.google.apiKey });
    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        expireTime: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
        newSessionExpireTime: new Date(Date.now() + CONNECT_WINDOW_MS).toISOString(),
        liveConnectConstraints: { model, config: liveConfig },
        // No lockAdditionalFields: an empty list makes the API reject setup
        // ("field_mask is invalid"), verified 2026-09-30. The constraint above
        // already locks every field it sets.
      },
    });

    await logOpsEvent({
      level: "info",
      event: body.resumeHandle ? "assistant.session_resumed" : "assistant.session_started",
      source: "console",
      actor: user,
      data: { mode, model, pathname },
    });

    return NextResponse.json({ token: token.name, model, config: liveConfig });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await logOpsEvent({ level: "error", event: "assistant.token_failed", source: "console", actor: user, data: { mode, message } });
    return NextResponse.json({ error: "token_failed", message }, { status: 502 });
  }
}
