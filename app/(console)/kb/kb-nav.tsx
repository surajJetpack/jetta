import Link from "next/link";
import { cn } from "@/lib/utils";

/** Sub-navigation inside the Knowledge Base tab. */
export function KbNav({
  current,
  draftCount,
}: {
  current: "list" | "review";
  draftCount?: number;
}) {
  const tabs = [
    { id: "list" as const, href: "/kb", label: "Articles" },
    {
      id: "review" as const,
      href: "/kb/review",
      label: `Review queue${typeof draftCount === "number" && draftCount > 0 ? ` (${draftCount})` : ""}`,
    },
  ];
  return (
    <nav aria-label="Knowledge base sections">
      <div className="inline-flex gap-1 rounded-lg border bg-card p-1">
        {tabs.map((t) => (
          <Link
            key={t.id}
            href={t.href}
            aria-current={t.id === current ? "page" : undefined}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
              t.id === current
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {t.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
