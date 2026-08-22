/**
 * The small face beside a chat bubble — Jetta's configured avatar (the same
 * image the visitor saw in the widget), a visitor's initials, or a human
 * agent's initials. Always the same 24px slot whether or not an image exists,
 * so a missing avatar never shifts the transcript layout.
 */
import { Bot, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";

/** "Priya Sharma" → "PS", "priya@x.com" → "P", "" → null (icon fallback). */
function initials(name: string | undefined): string | null {
  const words = (name ?? "").trim().split(/[\s.@_-]+/).filter(Boolean);
  if (!words.length) return null;
  return words
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

export function ChatAvatar({
  kind,
  src,
  name,
  className,
}: {
  kind: "jetta" | "visitor" | "human";
  /** Jetta's avatar image (a settings data URI) — icon fallback when unset. */
  src?: string;
  /** Whose initials to show, for visitor/human kinds. */
  name?: string;
  className?: string;
}) {
  const base = "flex size-6 shrink-0 select-none items-center justify-center overflow-hidden rounded-full text-[10px] font-semibold";
  if (kind === "jetta") {
    return src ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt="Jetta" title="Jetta" className={cn(base, "object-cover", className)} />
    ) : (
      <span className={cn(base, "bg-primary/10 text-primary", className)} title="Jetta">
        <Bot className="size-3.5" aria-hidden />
      </span>
    );
  }
  const label = initials(name);
  if (kind === "human") {
    return (
      <span
        className={cn(base, "border border-primary/40 bg-primary/5 text-primary", className)}
        title={name ? `${name} · human` : "human"}
      >
        {label ?? <UserRound className="size-3.5" aria-hidden />}
      </span>
    );
  }
  return (
    <span className={cn(base, "bg-muted text-muted-foreground", className)} title={name || "visitor"}>
      {label ?? <UserRound className="size-3.5" aria-hidden />}
    </span>
  );
}
