"use client";

/**
 * "Understand / Support health" at the left of the topbar — where you are, in
 * the same words as the sidebar. Derived from the nav model, so a page added
 * there gets its crumb for free and the two can never disagree.
 */
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { GUIDE_ITEM, activeId, navFor } from "./console-nav";

export function Breadcrumbs({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const id = activeId(pathname, isAdmin);
  if (!id) return null;

  const group = navFor(isAdmin).find((g) => g.items.some((i) => i.id === id));
  const item = group?.items.find((i) => i.id === id) ?? (id === GUIDE_ITEM.id ? GUIDE_ITEM : null);
  if (!item) return null;

  return (
    <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-1.5 text-sm lg:flex">
      {group && (
        <>
          <span className="text-muted-foreground">{group.label}</span>
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
        </>
      )}
      <span className="truncate font-medium text-foreground" aria-current="page">
        {item.label}
      </span>
    </nav>
  );
}
