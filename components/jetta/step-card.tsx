/**
 * The console's list-item language (legacy `.step` / `.tool` / `.io`):
 * a bordered muted block with an accent-colored title row, optionally
 * collapsible via a real <button> header (keyboard accessible).
 */
"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export function StepCard({
  title,
  meta,
  collapsible = false,
  defaultOpen = true,
  className,
  children,
}: {
  /** Left side of the header row (icon + text). */
  title: React.ReactNode;
  /** Right side of the header row (chips, timestamps). */
  meta?: React.ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  const header = (
    <>
      <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-primary [&_svg]:size-4 [&_svg]:shrink-0">
        {collapsible && (open ? <ChevronDown className="text-muted-foreground" /> : <ChevronRight className="text-muted-foreground" />)}
        <span className="truncate">{title}</span>
      </span>
      {meta && <span className="flex shrink-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">{meta}</span>}
    </>
  );

  return (
    <div className={cn("rounded-lg border bg-muted/40 p-3", className)}>
      {collapsible ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-sm text-left focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {header}
        </button>
      ) : (
        <div className="flex items-center justify-between gap-3">{header}</div>
      )}
      {(!collapsible || open) && children ? <div className="mt-2 space-y-2">{children}</div> : null}
    </div>
  );
}

/** Monospace input/output block inside a StepCard (legacy `.io`). */
export function TraceIO({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("overflow-x-auto rounded-md bg-background/60 p-2 font-mono text-xs text-muted-foreground", className)}>
      {children}
    </div>
  );
}
