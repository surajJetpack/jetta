/**
 * The browser half of a console voice session: microphone in, Jetta's voice
 * out, and her tool calls relayed.
 *
 * Framework-free on purpose — a class with callbacks rather than a hook — so
 * the audio graph, the socket and the reconnect logic have one owner whose
 * lifetime is explicit. React re-renders must never be what opens a second
 * socket or a second microphone.
 *
 * Audio formats are fixed by the Live API: 16-bit little-endian PCM at 16 kHz
 * in, 24 kHz out. Capture runs at the device's native rate and is downsampled
 * here, because Firefox refuses to connect a microphone to an AudioContext
 * running at any other rate.
 */
import {
  GoogleGenAI,
  type LiveServerMessage,
  type LiveConnectConfig,
  type Session,
} from "@google/genai";

type ClientContent = Parameters<Session["sendClientContent"]>[0];

export type AssistantMode = "live" | "deep";
export type VoiceState = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "error";

export interface PanelLink {
  label: string;
  url: string;
}

export interface TranscriptLine {
  id: number;
  who: "you" | "jetta" | "tool";
  text: string;
  /** Clickable links Jetta put in the panel (show_links). */
  links?: PanelLink[];
  /** Still being spoken — the transcription streams in fragments. */
  partial?: boolean;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface VoiceCallbacks {
  onState: (s: VoiceState) => void;
  onTranscript: (lines: TranscriptLine[]) => void;
  /** Runs a tool; resolves with what the model should be told. */
  onToolCall: (call: ToolCall) => Promise<Record<string, unknown>>;
  onError: (message: string) => void;
  /** Deep mode is entered and left by Jetta herself; the panel only shows it. */
  onMode?: (m: AssistantMode) => void;
}

interface SessionGrant {
  token: string;
  model: string;
  config: LiveConnectConfig;
}

const IN_RATE = 16_000;
const OUT_RATE = 24_000;
/** ~100 ms of audio per message: small enough for barge-in to feel instant, large enough not to flood the socket. */
const CHUNK_SAMPLES = IN_RATE / 10;

/**
 * Posts raw microphone frames to the main thread. Inlined as a Blob so there is
 * no static file whose path can drift from this code.
 */
const WORKLET = `
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("jetta-capture", Capture);
`;

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class LiveVoice {
  private cb: VoiceCallbacks;
  private mode: AssistantMode = "live";
  private session: Session | null = null;
  private resumeHandle: string | undefined;
  private pathname = "/";
  private reconnecting = false;
  private gen = 0;
  private outbox: ClientContent[] = [];
  /** In deep mode because she escalated a question — go back once it is answered. */
  private escalated = false;
  private returnPending = false;

  private micStream: MediaStream | null = null;
  private inCtx: AudioContext | null = null;
  private outCtx: AudioContext | null = null;
  private muted = false;
  private pending: number[] = [];
  private ratio = 3;
  private carry = 0;

  private playing = new Set<AudioBufferSourceNode>();
  /** Taps for the visualiser — read-only, never on the path to the speakers or the socket. */
  private inAnalyser: AnalyserNode | null = null;
  private outAnalyser: AnalyserNode | null = null;
  /** fftSize 256 → 128 bins, reused every frame. */
  private bins = new Uint8Array(128);
  private playhead = 0;

  private lines: TranscriptLine[] = [];
  private seq = 0;
  private state: VoiceState = "idle";

  constructor(cb: VoiceCallbacks) {
    this.cb = cb;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────

  /**
   * Start listening. If there is a transcript from before a pause (the panel was
   * minimised), the new session is handed it, so the conversation resumes
   * rather than restarts.
   */
  async start(pathname: string): Promise<void> {
    this.setMode("live");
    this.pathname = pathname;
    const history = this.historyText();
    if (history) this.sendContext(`The panel was minimised and reopened. The conversation so far:\n${history}`);
    this.setState("connecting");
    try {
      // Both contexts are created inside the click that started the session:
      // browsers only let audio play from a user gesture.
      this.outCtx = new AudioContext({ sampleRate: OUT_RATE });
      this.outAnalyser = this.outCtx.createAnalyser();
      this.outAnalyser.fftSize = 256;
      this.outAnalyser.smoothingTimeConstant = 0.7;
      this.outAnalyser.connect(this.outCtx.destination);
      await this.startMic();
      await this.connect();
    } catch (e) {
      this.fail(e);
    }
  }

  async stop(): Promise<void> {
    this.dropSession();
    this.outbox = [];
    this.flushPlayback();
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    await this.inCtx?.close().catch(() => {});
    await this.outCtx?.close().catch(() => {});
    this.inCtx = this.outCtx = null;
    this.inAnalyser = this.outAnalyser = null;
    this.resumeHandle = undefined;
    this.escalated = this.returnPending = false;
    this.setState("idle");
  }

  /**
   * Switch model. A resumption handle belongs to one model, so the new session
   * starts fresh and is handed the transcript so far as context instead.
   * `answerNow` makes the new model take the question that prompted the switch.
   */
  private async switchMode(mode: AssistantMode, answerNow = false): Promise<void> {
    if (mode === this.mode || this.state === "idle" || this.state === "error") return;
    this.setMode(mode);
    this.dropSession();
    this.flushPlayback();
    this.resumeHandle = undefined;
    const history = this.historyText();
    // Queued before connecting, so it is the first thing the new model reads —
    // ahead of anything the user says while the switch is in flight.
    if (history) this.sendContext(`Switched to ${mode} mode. The conversation so far:\n${history}`);
    if (answerNow) {
      this.send({
        turns: [{ role: "user", parts: [{ text: "[context] The quick model handed you the user's most recent question because it needs real reasoning. Answer it now." }] }],
        turnComplete: true,
      });
      this.addLine("tool", "Thinking deeper");
    }
    this.setState(answerNow ? "thinking" : "connecting");
    try {
      await this.connect();
    } catch (e) {
      this.fail(e);
    }
  }

  /**
   * She decided the question needs the extended-thinking model. The quick
   * session is dropped mid-call — it gets no tool response, so it has nothing
   * to say about the handover — and the deep one answers.
   */
  private escalate(): void {
    this.escalated = true;
    void this.switchMode("deep", true);
  }

  /**
   * Back to the quick model once the deep answer has been SPOKEN, not merely
   * generated — switching drops the socket, and with it any audio still queued.
   */
  private maybeReturn(): void {
    if (!this.returnPending || this.playing.size) return;
    // They asked something while the deep answer was finishing. Switching now
    // would drop the socket with that question unanswered — stay, let the deep
    // model take it, and go back after the next IDLE instead.
    const lastSpoken = [...this.lines].reverse().find((l) => l.who !== "tool");
    if (lastSpoken?.who === "you") return;
    this.returnPending = this.escalated = false;
    void this.switchMode("live");
  }

  private historyText(): string {
    return this.lines
      .filter((l) => l.who !== "tool" && l.text)
      .slice(-30)
      .map((l) => `${l.who === "you" ? "User" : "Jetta"}: ${l.text}`)
      .join("\n");
  }

  private setMode(m: AssistantMode): void {
    if (m === this.mode) return;
    this.mode = m;
    this.cb.onMode?.(m);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.pending = [];
  }

  /** A typed question, answered aloud like a spoken one. Safe to call while still connecting. */
  sendText(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.addLine("you", t);
    this.send({ turns: [{ role: "user", parts: [{ text: t }] }], turnComplete: true });
    this.setState("thinking");
  }

  /**
   * Silent context — the page they moved to, the mode they switched to. Sent
   * without completing the turn, so it informs the next answer instead of
   * prompting one.
   */
  sendContext(text: string): void {
    this.send({ turns: [{ role: "user", parts: [{ text: `[context] ${text}` }] }], turnComplete: false });
  }

  setPathname(pathname: string): void {
    if (pathname === this.pathname) return;
    this.pathname = pathname;
    if (this.state !== "idle" && this.state !== "error") this.sendContext(`The user is now on ${pathname}.`);
  }

  /**
   * Text sent before the socket is up — typed the instant the panel opened, or
   * during a mode switch — waits here instead of vanishing. People do not wait
   * for "Listening" before they start.
   */
  private send(content: ClientContent): void {
    if (this.session) this.session.sendClientContent(content);
    else this.outbox.push(content);
  }

  // ── connection ─────────────────────────────────────────────────────────

  private async grant(): Promise<SessionGrant> {
    const res = await fetch("/api/admin/assistant/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: this.mode, pathname: this.pathname, resumeHandle: this.resumeHandle }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message ?? body.error ?? `Session refused (${res.status})`);
    return body as SessionGrant;
  }

  /**
   * Every socket gets a generation number, and its callbacks are ignored once
   * a newer one exists. Without this, the old socket's close event — which
   * arrives AFTER a mode switch or reconnect has begun — reads as the session
   * dying and tears down the one that replaced it.
   */
  private async connect(): Promise<void> {
    const gen = ++this.gen;
    const g = await this.grant();
    if (gen !== this.gen) return;
    const ai = new GoogleGenAI({ apiKey: g.token, httpOptions: { apiVersion: "v1beta" } });
    const session = await ai.live.connect({
      model: g.model,
      config: g.config,
      callbacks: {
        onmessage: (m) => gen === this.gen && void this.onMessage(m),
        onerror: (e) => gen === this.gen && this.cb.onError(e.message || "Connection error"),
        onclose: (e) => gen === this.gen && void this.onClose(e.code, e.reason),
      },
    });
    if (gen !== this.gen) {
      session.close();
      return;
    }
    this.session = session;
    const queued = this.outbox;
    this.outbox = [];
    for (const c of queued) session.sendClientContent(c);
    this.setState(queued.some((c) => c.turnComplete) ? "thinking" : "listening");
  }

  /** Retire the current socket so nothing it says afterwards is heard. */
  private dropSession(): void {
    this.gen++;
    this.session?.close();
    this.session = null;
  }

  /**
   * Google recycles every connection after about ten minutes (sending GoAway
   * first). With a handle the conversation continues on a new socket; the
   * listener hears nothing but a short pause.
   */
  private async reconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.dropSession();
    try {
      await this.connect();
    } catch (e) {
      this.fail(e);
    } finally {
      this.reconnecting = false;
    }
  }

  private async onClose(code: number, reason: string): Promise<void> {
    this.session = null;
    if (this.resumeHandle) return this.reconnect();
    this.fail(new Error(reason || `Session closed (${code})`));
  }

  private async onMessage(m: LiveServerMessage): Promise<void> {
    if (m.sessionResumptionUpdate?.resumable && m.sessionResumptionUpdate.newHandle) {
      this.resumeHandle = m.sessionResumptionUpdate.newHandle;
    }
    if (m.goAway) void this.reconnect();

    if (m.toolCall?.functionCalls?.some((fc) => fc.name === "think_deeper")) {
      this.escalate();
      return;
    }
    if (m.toolCall?.functionCalls?.length) {
      this.setState("thinking");
      const responses = await Promise.all(
        m.toolCall.functionCalls.map(async (fc) => {
          const response = await this.cb
            .onToolCall({ name: fc.name ?? "", args: (fc.args ?? {}) as Record<string, unknown> })
            .catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
          // No `scheduling`, even for deep mode's NON_BLOCKING calls. Setting
          // WHEN_IDLE explicitly — nominally the default — leaves the extended
          // model silent after its "let me check" and it never answers
          // (reproduced 2026-09-30). Left unset, it answers as it should.
          return { id: fc.id, name: fc.name, response };
        }),
      );
      this.session?.sendToolResponse({ functionResponses: responses });
    }

    const sc = m.serverContent;
    if (!sc) return;

    if (sc.interrupted) {
      // They spoke over her. Stop talking immediately — the model has already
      // dropped the rest of the turn, so anything still queued is stale.
      this.flushPlayback();
      this.sealPartial("jetta");
    }
    if (sc.inputTranscription?.text) this.appendPartial("you", sc.inputTranscription.text);
    if (sc.outputTranscription?.text) {
      this.sealPartial("you");
      this.appendPartial("jetta", sc.outputTranscription.text);
    }
    for (const p of sc.modelTurn?.parts ?? []) {
      if (p.inlineData?.data && p.inlineData.mimeType?.startsWith("audio/")) this.play(p.inlineData.data);
    }
    if (sc.turnComplete) {
      this.sealPartial("you");
      this.sealPartial("jetta");
      // On the extended model turnComplete is not "done": background reasoning
      // may still be running, and only IDLE means she has nothing more to say.
      const idle = this.mode !== "deep" || sc.interactionStatus === "IDLE";
      if (idle && !this.playing.size) this.setState("listening");
      else if (!idle) this.setState("thinking");
      if (idle && this.mode === "deep" && this.escalated) {
        this.returnPending = true;
        this.maybeReturn();
      }
    }
  }

  // ── microphone ─────────────────────────────────────────────────────────

  private async startMic(): Promise<void> {
    this.micStream = await navigator.mediaDevices.getUserMedia({
      // Echo cancellation is what stops her hearing herself through the
      // speakers and interrupting her own answer.
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    this.inCtx = new AudioContext();
    this.ratio = this.inCtx.sampleRate / IN_RATE;
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    await this.inCtx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const src = this.inCtx.createMediaStreamSource(this.micStream);
    const node = new AudioWorkletNode(this.inCtx, "jetta-capture");
    node.port.onmessage = (e: MessageEvent<Float32Array>) => this.onFrames(e.data);
    src.connect(node);
    this.inAnalyser = this.inCtx.createAnalyser();
    this.inAnalyser.fftSize = 256;
    this.inAnalyser.smoothingTimeConstant = 0.7;
    src.connect(this.inAnalyser);
  }

  /** Downsample by averaging each window of native-rate samples into one 16 kHz sample. */
  private onFrames(frame: Float32Array): void {
    if (this.muted || !this.session) return;
    let pos = this.carry;
    while (pos < frame.length) {
      const start = Math.floor(pos);
      const end = Math.min(Math.floor(pos + this.ratio), frame.length);
      let sum = 0;
      for (let i = start; i < end; i++) sum += frame[i];
      this.pending.push(end > start ? sum / (end - start) : 0);
      pos += this.ratio;
    }
    this.carry = pos - frame.length;
    if (this.pending.length >= CHUNK_SAMPLES) this.flushMic();
  }

  private flushMic(): void {
    const samples = this.pending;
    this.pending = [];
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.session?.sendRealtimeInput({
      audio: { data: toBase64(new Uint8Array(pcm.buffer)), mimeType: `audio/pcm;rate=${IN_RATE}` },
    });
  }

  // ── playback ───────────────────────────────────────────────────────────

  private play(b64: string): void {
    const ctx = this.outCtx;
    if (!ctx) return;
    const bytes = fromBase64(b64);
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    const buf = ctx.createBuffer(1, pcm.length, OUT_RATE);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.outAnalyser ?? ctx.destination);
    // Chunks are queued back to back on the audio clock, not played on
    // arrival — network jitter would otherwise be audible as stutter.
    this.playhead = Math.max(this.playhead, ctx.currentTime + 0.02);
    src.start(this.playhead);
    this.playhead += buf.duration;
    this.playing.add(src);
    this.setState("speaking");
    src.onended = () => {
      this.playing.delete(src);
      if (!this.playing.size && this.state === "speaking") this.setState("listening");
      this.maybeReturn();
    };
  }

  private flushPlayback(): void {
    for (const s of this.playing) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.playing.clear();
    this.playhead = 0;
    if (this.state === "speaking") this.setState("listening");
  }

  // ── visualiser ─────────────────────────────────────────────────────────

  /**
   * Frequency bins (0–1) for whoever is audible: Jetta while she speaks, the
   * microphone otherwise (silent when muted). Fills `out` in place so the
   * render loop allocates nothing per frame.
   */
  readSpectrum(out: Float32Array): number {
    const a = this.playing.size ? this.outAnalyser : this.muted ? null : this.inAnalyser;
    if (!a) {
      out.fill(0);
      return 0;
    }
    const bins = this.bins;
    a.getByteFrequencyData(bins);
    // Voice lives in the low third of the spectrum; stretch it over every bar.
    const span = Math.floor(bins.length / 3);
    let sum = 0;
    for (let i = 0; i < out.length; i++) {
      const v = bins[Math.floor((i / out.length) * span)] / 255;
      out[i] = v;
      sum += v;
    }
    return sum / out.length;
  }

  // ── transcript ─────────────────────────────────────────────────────────

  addLine(who: TranscriptLine["who"], text: string, links?: PanelLink[]): void {
    this.lines = [...this.lines, { id: ++this.seq, who, text, ...(links?.length ? { links } : {}) }];
    this.cb.onTranscript(this.lines);
  }

  private appendPartial(who: "you" | "jetta", text: string): void {
    const last = this.lines[this.lines.length - 1];
    if (last && last.who === who && last.partial) {
      this.lines = [...this.lines.slice(0, -1), { ...last, text: last.text + text }];
    } else {
      this.lines = [...this.lines, { id: ++this.seq, who, text: text.trimStart(), partial: true }];
    }
    this.cb.onTranscript(this.lines);
  }

  private sealPartial(who: "you" | "jetta"): void {
    let changed = false;
    this.lines = this.lines.map((l) => {
      if (l.who === who && l.partial) {
        changed = true;
        return { ...l, partial: false, text: l.text.trim() };
      }
      return l;
    });
    if (changed) this.cb.onTranscript(this.lines);
  }

  clearTranscript(): void {
    this.lines = [];
    this.cb.onTranscript(this.lines);
  }

  private setState(s: VoiceState): void {
    if (s === this.state) return;
    this.state = s;
    this.cb.onState(s);
  }

  private fail(e: unknown): void {
    const message =
      e instanceof DOMException && e.name === "NotAllowedError"
        ? "Microphone access was blocked. Allow it in the browser's address bar and try again."
        : e instanceof Error
          ? e.message
          : String(e);
    this.cb.onError(message);
    void this.stop().then(() => this.setState("error"));
  }
}
