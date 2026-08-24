"use client";

/**
 * The console's notification sound.
 *
 * Two chimes, one job: making a hidden tab able to say "a visitor needs you".
 * The badges already say it visually, but live chat is the one queue where the
 * person watching it is also doing other work — and a sound is the only signal
 * that crosses a backgrounded tab.
 *
 * Synthesised with WebAudio rather than shipped as a file: two sine notes need
 * no asset, no request, and no license. Browsers only allow audio after a user
 * gesture in the page, so `armChime` registers a one-time unlock on the first
 * click or keypress — anyone working the console has gestured long before the
 * first visitor arrives, and a console tab that was opened and never touched
 * stays silent, which is the polite failure.
 */

const ENABLED_KEY = "jetta.chime";
const LAST_KEY = "jetta.chime.last";
/**
 * Shared across tabs through localStorage: the sidebar poll runs in every open
 * console tab, and three tabs discovering the same waiting visitor within a
 * poll cycle should ring once, not three times.
 */
const DEBOUNCE_MS = 2500;

let ctx: AudioContext | null = null;
let armed = false;
/** Same-tab subscribers — localStorage's own event only crosses tabs. */
const listeners = new Set<() => void>();

/** On unless it was turned off — a sound nobody enabled is still the default. */
export function chimeEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== "off";
  } catch {
    return false;
  }
}

export function setChimeEnabled(on: boolean) {
  try {
    localStorage.setItem(ENABLED_KEY, on ? "on" : "off");
  } catch {
    /* private mode: the toggle lasts the tab, which is still a toggle */
  }
  listeners.forEach((fn) => fn());
}

/**
 * For useSyncExternalStore — the setting lives in localStorage, which the
 * server can't read, and this is the hydration-safe way to render it. Also
 * listens across tabs: muting the bell in one console tab mutes them all,
 * which is what "the bell" means to the person clicking it.
 */
export function subscribeChime(fn: () => void): () => void {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key === ENABLED_KEY) fn();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("storage", onStorage);
  };
}

/** Idempotent; call from any component that may want to chime later. */
export function armChime() {
  if (armed || typeof window === "undefined") return;
  armed = true;
  const unlock = () => {
    try {
      ctx ??= new AudioContext();
      if (ctx.state === "suspended") void ctx.resume();
      if (ctx.state === "running") {
        window.removeEventListener("pointerdown", unlock, true);
        window.removeEventListener("keydown", unlock, true);
      }
    } catch {
      /* no audio here; the visual badges carry it */
    }
  };
  window.addEventListener("pointerdown", unlock, true);
  window.addEventListener("keydown", unlock, true);
}

/**
 * `waiting` — a visitor asked for a person: two rising notes, the summons.
 * `message` — a visitor replied in a chat a person already holds: one soft
 * note, because the conversation is already someone's.
 */
export function playChime(kind: "waiting" | "message") {
  if (!chimeEnabled() || !ctx) return;
  if (ctx.state !== "running") {
    // Safari suspends a context when the tab goes to the background — the
    // exact moment this sound is for. Once a gesture has unlocked the context,
    // resuming needs no new gesture, so try; a browser that refuses leaves the
    // state unchanged and strike() below stays silent.
    void ctx
      .resume()
      .then(() => strike(kind))
      .catch(() => {});
    return;
  }
  strike(kind);
}

function strike(kind: "waiting" | "message") {
  if (!ctx || ctx.state !== "running") return;
  try {
    // The cross-tab claim happens HERE, only in a tab that can actually ring.
    // Claiming it earlier let a tab whose audio was never unlocked consume the
    // ring and leave every other tab silent.
    const now = Date.now();
    if (now - Number(localStorage.getItem(LAST_KEY) || 0) < DEBOUNCE_MS) return;
    localStorage.setItem(LAST_KEY, String(now));
  } catch {
    /* no storage means no cross-tab dedupe — ring anyway */
  }
  const t = ctx.currentTime + 0.02;
  if (kind === "waiting") {
    note(659, t, 0.18);
    note(880, t + 0.13, 0.24);
  } else {
    note(740, t, 0.16);
  }
}

function note(freq: number, at: number, dur: number) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  // A fast attack and an exponential tail — the shape of a bell rather than a
  // buzzer — kept quiet enough to notice without making anyone flinch.
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(0.07, at + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + dur + 0.05);
}
