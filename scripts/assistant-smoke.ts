// Headless check of the console voice assistant against the real Live API: the
// real instructions, declarations and read-only tools — a typed question in,
// the spoken answer's transcript out. Run after changing the prompt or tools.
//   npx tsx --env-file=.env.local scripts/assistant-smoke.ts [live|deep] "question"
import { GoogleGenAI, Modality, type LiveServerMessage, type LiveConnectConfig } from "@google/genai";
import { LIVE_MODELS, buildInstructions, liveDeclarations, runConsoleTool, CLIENT_TOOLS, type AssistantMode } from "../lib/console-assistant";

const mode = (process.argv[2] ?? "live") as AssistantMode;
const question = process.argv[3] ?? "Are monday dev-board writes switched on right now?";

async function main() {
  const model = LIVE_MODELS[mode];
  const systemInstruction = await buildInstructions({ user: "suraj", pathname: "/today", mode });
  console.log(`instructions ${systemInstruction.length} chars (~${Math.round(systemInstruction.length / 4)} tokens), ${liveDeclarations(mode).length} tools`);
  const cfg: LiveConnectConfig = {
    responseModalities: [Modality.AUDIO],
    systemInstruction,
    tools: [{ functionDeclarations: liveDeclarations(mode) }],
    outputAudioTranscription: {},
    sessionResumption: {},
    contextWindowCompression: { slidingWindow: {} },
    ...(mode === "deep" ? { thinkingConfig: { thinkingLevel: "LOW" as never } } : {}),
  };
  const server = new GoogleGenAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY! });
  const token = await server.authTokens.create({
    config: { uses: 1, liveConnectConstraints: { model, config: cfg } },
  });
  const client = new GoogleGenAI({ apiKey: token.name!, httpOptions: { apiVersion: "v1beta" } });
  const t0 = Date.now();
  let transcript = "";
  let done!: () => void;
  const finished = new Promise<void>((r) => (done = r));
  const session = await client.live.connect({
    model,
    config: cfg,
    callbacks: {
      onmessage: async (m: LiveServerMessage) => {
        for (const fc of m.toolCall?.functionCalls ?? []) {
          console.log(`+${Date.now() - t0}ms tool ${fc.name} ${JSON.stringify(fc.args)}`);
          let response: Record<string, unknown>;
          if ((CLIENT_TOOLS as readonly string[]).includes(fc.name!)) response = { ok: true };
          else {
            try {
              response = { result: await runConsoleTool(fc.name!, fc.args) };
            } catch (e) {
              response = { error: String(e) };
            }
          }
          console.log(`   → ${JSON.stringify(response).slice(0, 160)}`);
          session.sendToolResponse({ functionResponses: [{ id: fc.id, name: fc.name, response }] });
        }
        const sc = m.serverContent;
        if (sc?.outputTranscription?.text) transcript += sc.outputTranscription.text;
        if (sc?.turnComplete && (mode === "live" || sc.interactionStatus === "IDLE")) done();
      },
      onerror: (e) => console.log("error", e.message),
      onclose: (e) => console.log("close", e.code, e.reason),
    },
  });
  session.sendClientContent({ turns: [{ role: "user", parts: [{ text: question }] }], turnComplete: true });
  await Promise.race([finished, new Promise((r) => setTimeout(r, 90_000))]);
  console.log(`+${Date.now() - t0}ms SAID: ${transcript}`);
  session.close();
  process.exit(0);
}
main().catch((e) => {
  console.error("FAILED", e?.message ?? e);
  process.exit(1);
});
