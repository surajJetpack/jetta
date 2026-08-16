"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "radix-ui";
import { ExternalLink, Search, TicketCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { navItemsFor } from "./console-nav";

/**
 * ⌘K — go anywhere, or open a ticket.
 *
 * Two things, both of which the console had no answer for. Navigation is the
 * obvious half. The other is that a ticket id is the atom of this whole system
 * — it is what Slack pings quote, what the Freshdesk note links, what someone
 * reads out loud — and until now the only way to act on one was to leave the
 * console and search Freshdesk by hand.
 *
 * Deliberately NOT wired to knowledge-base search: /api/admin/kb/search runs
 * the full agent retrieval pipeline including an LLM rerank, which is the
 * right thing for testing retrieval and completely wrong to fire on every
 * keystroke. A palette that costs a model call per character is a palette
 * nobody is allowed to use.
 */
export function CommandPalette({
  isAdmin,
  freshdeskDomain,
}: {
  isAdmin: boolean;
  /** Empty when Freshdesk isn't configured — the ticket row then hides itself. */
  freshdeskDomain: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const router = useRouter();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    const rows: Result[] = [];

    // A bare number is almost certainly a ticket. Offered first, because
    // someone who typed one already knows where they want to go.
    const ticket = q.trim().replace(/^#/, "");
    if (freshdeskDomain && /^\d{2,}$/.test(ticket)) {
      rows.push({
        key: `ticket-${ticket}`,
        label: `Open ticket #${ticket}`,
        hint: "in Freshdesk",
        href: `https://${freshdeskDomain}/a/tickets/${ticket}`,
        external: true,
      });
    }

    for (const item of navItemsFor(isAdmin)) {
      if (term && !`${item.label} ${item.hint}`.toLowerCase().includes(term)) continue;
      rows.push({ key: item.id, label: item.label, hint: item.hint, href: item.href });
    }
    return rows;
  }, [q, isAdmin, freshdeskDomain]);

  // Typing resets the cursor to the best match — done here rather than in an
  // effect, because the cursor is derived from the same event as the query and
  // an effect would render the stale pairing first.
  function type(next: string) {
    setQ(next);
    setCursor(0);
  }

  function go(r: Result | undefined) {
    if (!r) return;
    setOpen(false);
    setQ("");
    if (r.external) window.open(r.href, "_blank", "noopener,noreferrer");
    else router.push(r.href);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(results[cursor]);
    }
  }

  // Keep the highlighted row on screen when arrowing past the fold.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setQ("");
      }}
    >
      {/* The trigger doubles as the affordance: without something search-shaped
          in the chrome, ⌘K is a feature only the person who built it knows. */}
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="flex h-8 w-full max-w-xs items-center gap-2 rounded-md border bg-card px-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <Search className="size-3.5 shrink-0" aria-hidden />
          <span className="flex-1 truncate text-left">Search…</span>
          <kbd className="hidden shrink-0 rounded border bg-muted px-1 font-mono text-[10px] sm:inline">
            ⌘K
          </kbd>
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px] data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          onKeyDown={onKeyDown}
          className="fixed top-[15vh] left-1/2 z-50 w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-lg border bg-popover shadow-lg data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <Dialog.Title className="sr-only">Search the console</Dialog.Title>
          <Dialog.Description className="sr-only">
            Jump to a page, or type a ticket number to open it in Freshdesk.
          </Dialog.Description>

          <div className="flex items-center gap-2.5 border-b px-3.5">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <input
              autoFocus
              value={q}
              onChange={(e) => type(e.target.value)}
              placeholder="Go to a page, or type a ticket number…"
              aria-label="Search the console"
              className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>

          <div ref={listRef} className="max-h-[min(20rem,50vh)] overflow-y-auto p-1.5" role="listbox">
            {results.length === 0 && (
              <p className="px-2.5 py-6 text-center text-sm text-muted-foreground">
                Nothing matches “{q}”.
              </p>
            )}
            {results.map((r, i) => (
              <button
                key={r.key}
                type="button"
                role="option"
                aria-selected={i === cursor}
                data-active={i === cursor}
                onMouseEnter={() => setCursor(i)}
                onClick={() => go(r)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors",
                  i === cursor ? "bg-muted" : "hover:bg-muted/60",
                )}
              >
                {r.external ? (
                  <TicketCheck className="size-4 shrink-0 text-primary" aria-hidden />
                ) : (
                  <span className="size-4 shrink-0" aria-hidden />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{r.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">{r.hint}</span>
                </span>
                {r.external && (
                  <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                )}
              </button>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface Result {
  key: string;
  label: string;
  hint: string;
  href: string;
  external?: boolean;
}
