"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export interface Section {
  id: string;
  label: string;
}

/**
 * A sticky jump-bar for pages that are genuinely several pages stacked.
 *
 * Insights is the case that needed it: five independent panels — yesterday's
 * rollup, the charts, learning analytics, the run log, the event log — one
 * after another, so reaching the event log to answer "why did that happen"
 * meant scrolling past four things you weren't looking for. Splitting them
 * across routes would be worse: they're read together during an
 * investigation, and each is cheap to render.
 *
 * Highlights whatever is nearest the top of the viewport, so the bar answers
 * "where am I" as well as "where can I go". The observer is deliberately
 * top-biased (a narrow band just under the sticky headers) rather than
 * intersection-ratio based — ratio treats a tall panel as active while its
 * heading is far off-screen.
 */
export function SectionNav({ sections, className }: { sections: Section[]; className?: string }) {
  const [active, setActive] = useState<string | null>(sections[0]?.id ?? null);

  useEffect(() => {
    const targets = sections
      .map((s) => document.getElementById(s.id))
      .filter((el): el is HTMLElement => el !== null);
    if (!targets.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const top = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActive(top.target.id);
      },
      // Band from just below the sticky topbar to a third down the viewport.
      { rootMargin: "-64px 0px -67% 0px", threshold: 0 },
    );
    targets.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [sections]);

  return (
    <nav
      aria-label="Sections"
      className={cn(
        "sticky top-12 z-20 -mx-4 overflow-x-auto border-b bg-background/85 px-4 py-2 backdrop-blur-sm [scrollbar-width:none] sm:-mx-6 sm:px-6",
        className,
      )}
    >
      <ul className="flex gap-1">
        {sections.map((s) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              aria-current={active === s.id ? "true" : undefined}
              className={cn(
                "inline-block rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                active === s.id
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * Anchor target for a SectionNav entry. `scroll-mt` clears the sticky topbar
 * and the jump-bar itself, so a jumped-to heading isn't hidden under them.
 */
export function SectionAnchor({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  // Own flex column, because a panel may render several cards and the page
  // container's gap only spaces the section, not what's inside it.
  return (
    <section id={id} className="flex scroll-mt-24 flex-col gap-5">
      {children}
    </section>
  );
}
