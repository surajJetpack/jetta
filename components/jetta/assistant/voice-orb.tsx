"use client";

import { useEffect, useRef } from "react";
import type { VoiceState } from "./live-voice";

type Hues = Record<VoiceState | "deep", [string, string]>;

/** Deeper, more saturated hues for the light panel — the dark set washes out on white. */
const LIGHT: Hues = {
  idle: ["#94a3b8", "#cbd5e1"],
  error: ["#ef4444", "#fca5a5"],
  connecting: ["#06b6d4", "#67e8f9"],
  listening: ["#0891b2", "#22d3ee"],
  speaking: ["#0284c7", "#6366f1"],
  thinking: ["#7c3aed", "#6366f1"],
  deep: ["#c026d3", "#7c3aed"],
};

/** The HUD palette for a dark console. */
const DARK: Hues = {
  idle: ["#64748b", "#334155"],
  error: ["#f87171", "#7f1d1d"],
  connecting: ["#67e8f9", "#0e7490"],
  listening: ["#22d3ee", "#0891b2"],
  speaking: ["#38bdf8", "#818cf8"],
  thinking: ["#a78bfa", "#6366f1"],
  deep: ["#e879f9", "#8b5cf6"],
};

const BARS = 72;

/**
 * Jetta's presence: a core that breathes, a ring of bars driven by the live
 * audio (her voice while she speaks, yours while she listens), and orbiting
 * arcs while she thinks. It is the status indicator — state is readable from
 * colour and motion alone, and the text label beside it says the same thing.
 *
 * Canvas, one rAF loop, no allocation per frame beyond the gradients the 2D
 * API requires. Honours reduced motion by drawing a single still frame per
 * state change.
 */
export function VoiceOrb({
  state,
  deep,
  readSpectrum,
  size = 132,
  className,
}: {
  state: VoiceState;
  deep: boolean;
  readSpectrum: (out: Float32Array) => number;
  size?: number;
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    el.width = size * dpr;
    el.height = size * dpr;
    ctx.scale(dpr, dpr);

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const spectrum = new Float32Array(BARS);
    const smooth = new Float32Array(BARS);
    let level = 0;
    let raf = 0;
    const t0 = performance.now();

    const draw = () => {
      const st = state;
      const dp = deep;
      const read = readSpectrum;
      const t = (performance.now() - t0) / 1000;
      const active = st === "listening" || st === "speaking";
      const avg = active ? read(spectrum) : (spectrum.fill(0), 0);
      level += (avg - level) * 0.18;
      for (let i = 0; i < BARS; i++) smooth[i] += (spectrum[i] - smooth[i]) * 0.35;

      // Read per frame: the theme can flip while the panel is open.
      const dark = document.documentElement.classList.contains("dark");
      const [hot, cool] = (dark ? DARK : LIGHT)[dp && st === "thinking" ? "deep" : st];
      const c = size / 2;
      const r = size * 0.2;
      const breathe = reduce ? 0 : Math.sin(t * (st === "idle" ? 1.2 : 2.2)) * 0.04;

      ctx.clearRect(0, 0, size, size);

      // Halo.
      const halo = ctx.createRadialGradient(c, c, r * 0.4, c, c, size / 2);
      halo.addColorStop(0, `${hot}${dark ? "55" : "30"}`);
      halo.addColorStop(0.45, `${cool}${dark ? "22" : "18"}`);
      halo.addColorStop(1, "transparent");
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(c, c, size / 2, 0, Math.PI * 2);
      ctx.fill();

      // Spectrum ring.
      ctx.lineCap = "round";
      ctx.lineWidth = Math.max(1.5, size / 90);
      for (let i = 0; i < BARS; i++) {
        const a = (i / BARS) * Math.PI * 2 - Math.PI / 2;
        // Mirror the bins so the ring is symmetrical — voice energy reads as
        // the whole shape swelling rather than one side twitching.
        const v = smooth[i < BARS / 2 ? i : BARS - 1 - i];
        const idleRipple = reduce ? 0 : (Math.sin(t * 1.6 + i * 0.35) + 1) * 0.5;
        const len = 2 + v * r * 1.1 + (active ? 0 : idleRipple * 2.5);
        const r0 = r * 1.32;
        ctx.strokeStyle = `${hot}${Math.round(90 + v * 165).toString(16).padStart(2, "0")}`;
        ctx.beginPath();
        ctx.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
        ctx.lineTo(c + Math.cos(a) * (r0 + len), c + Math.sin(a) * (r0 + len));
        ctx.stroke();
      }

      // Orbiting arcs while she thinks or connects.
      if (st === "thinking" || st === "connecting") {
        ctx.lineWidth = Math.max(1.5, size / 70);
        for (let k = 0; k < 3; k++) {
          const rad = r * (1.05 + k * 0.1);
          const start = (reduce ? k : t * (1.4 + k * 0.7) * (k % 2 ? -1 : 1)) + k * 2;
          ctx.strokeStyle = `${k === 1 ? cool : hot}cc`;
          ctx.beginPath();
          ctx.arc(c, c, rad, start, start + Math.PI * (0.35 + k * 0.15));
          ctx.stroke();
        }
      }

      // Core.
      const cr = r * (0.78 + breathe + level * 0.55);
      const core = ctx.createRadialGradient(c - cr * 0.3, c - cr * 0.35, cr * 0.05, c, c, cr);
      core.addColorStop(0, "#ffffff");
      core.addColorStop(0.25, hot);
      core.addColorStop(1, `${cool}00`);
      ctx.fillStyle = core;
      ctx.shadowColor = hot;
      ctx.shadowBlur = 18 + level * 30;
      ctx.beginPath();
      ctx.arc(c, c, cr, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      if (!reduce) raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
    // A state change restarts the loop (cheap — one canvas, no allocation),
    // which is also what redraws the still frame under reduced motion.
  }, [size, state, deep, readSpectrum]);

  return <canvas ref={canvas} style={{ width: size, height: size }} className={className} aria-hidden />;
}
