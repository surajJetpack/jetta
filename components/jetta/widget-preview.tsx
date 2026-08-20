"use client";

/**
 * A still of the chat widget, drawn from settings alone.
 *
 * Not the widget itself: app/chat/page.tsx is wired to the postMessage
 * handshake and opens a session the moment it mounts, so embedding the real
 * thing in a settings page would file a support conversation nobody had. This
 * renders the four surfaces a visitor actually judges — launcher, header,
 * greeting, composer — and nothing else.
 *
 * It borrows the widget's own neutral palette rather than the console's
 * tokens, because the point is to show what a customer sees on their own site,
 * not what this page looks like.
 */
import { MessageCircle } from "lucide-react";

export interface PreviewSettings {
  title: string;
  subtitle: string;
  greeting: string;
  placeholder: string;
  accentColor: string;
  launcherLabel: string;
  launcherPosition: "left" | "right";
  launcherIcon: "bubble" | "avatar";
  avatarUrl?: string;
  requireIdentity: boolean;
  autoOpenSeconds: number;
}

export function WidgetPreview({ s, label }: { s: PreviewSettings; label?: string }) {
  const accent = /^#[0-9a-f]{6}$/i.test(s.accentColor) ? s.accentColor : "#171717";
  return (
    <div className="space-y-2">
      {label && (
        <p className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
          {label}
        </p>
      )}
      <div className="overflow-hidden rounded-xl border bg-neutral-50 p-4 dark:bg-neutral-900">
        <div className="mx-auto max-w-[320px] overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
          <header className="flex items-center gap-2.5 border-b border-neutral-200 px-4 py-3">
            {s.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={s.avatarUrl} alt="" className="size-8 shrink-0 rounded-full object-cover" />
            ) : (
              <span
                className="flex size-8 shrink-0 items-center justify-center rounded-full text-white"
                style={{ backgroundColor: accent }}
              >
                <MessageCircle className="size-4" />
              </span>
            )}
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-neutral-900">{s.title || "—"}</p>
              <p className="truncate text-xs text-neutral-500">{s.subtitle}</p>
            </div>
          </header>

          <div className="space-y-3 px-4 py-4">
            <p className="text-sm leading-relaxed text-neutral-700">{s.greeting}</p>

            {/* The identity gate is the first screen when it's on, so it is
                part of the picture rather than a footnote under it. */}
            {s.requireIdentity && (
              <div className="space-y-2">
                <div className="flex items-center gap-2" aria-hidden>
                  <span className="h-px flex-1 bg-neutral-200" />
                  <span className="text-[11px] font-medium text-neutral-400">Before we start</span>
                  <span className="h-px flex-1 bg-neutral-200" />
                </div>
                <div className="rounded-lg border border-neutral-300 px-3 py-2 text-sm text-neutral-400">
                  Your name
                </div>
                <div className="rounded-lg border border-neutral-300 px-3 py-2 text-sm text-neutral-400">
                  you@company.com
                </div>
                <div
                  className="rounded-lg px-3 py-2 text-center text-sm font-medium text-white"
                  style={{ backgroundColor: accent }}
                >
                  Start chatting
                </div>
              </div>
            )}

            {!s.requireIdentity && (
              <div className="rounded-lg border border-neutral-300 px-3 py-2 text-sm text-neutral-400">
                {s.placeholder}
              </div>
            )}
          </div>

        </div>

        {/* The launcher sits BELOW the panel, not inside it — it is the only
            part of the widget the embedding page owns, and drawing it in the
            footer made it look like a send button. Same shape as the real one
            (public/jettachat.js): the mark at the edge, the label growing
            inward, so a label set here is a label a visitor reads. */}
        <div
          className={`mt-3 flex items-center ${
            s.launcherPosition === "left" ? "justify-start" : "justify-end"
          }`}
        >
          <span
            className={`inline-flex items-center rounded-full text-white shadow-md ${
              s.launcherPosition === "left" ? "flex-row" : "flex-row-reverse"
            }`}
            style={{ backgroundColor: accent }}
          >
            <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full">
              {s.launcherIcon === "avatar" && s.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={s.avatarUrl} alt="" className="size-full object-cover" />
              ) : (
                <MessageCircle className="size-4" />
              )}
            </span>
            {s.launcherLabel && (
              <span
                className={`max-w-[160px] truncate text-xs font-semibold ${
                  s.launcherPosition === "left" ? "pr-3.5 pl-1" : "pr-1 pl-3.5"
                }`}
              >
                {s.launcherLabel}
              </span>
            )}
          </span>
        </div>

        <p className="mt-3 text-center text-[11px] text-muted-foreground">
          {s.autoOpenSeconds > 0
            ? `Opens by itself after ${s.autoOpenSeconds}s`
            : "Opens only when the visitor clicks"}
          {" · "}
          {s.requireIdentity ? "asks for name and email first" : "starts straight into the chat"}
        </p>
      </div>
    </div>
  );
}
