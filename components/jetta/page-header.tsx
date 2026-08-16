/**
 * Page and section headings.
 *
 * Every page currently opens its own way — some with a bare `<h1>`, some with
 * a Card title, some with nothing at all — which is why the console reads as a
 * stack of unrelated screens rather than one tool. These are the two heading
 * shapes it actually needs.
 */
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  /** One line on what this page is for. Skip it when the title says enough. */
  description?: React.ReactNode;
  /** Buttons and links, right-aligned and never wrapping under the title. */
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-2", className)}>
      <div className="min-w-0 space-y-0.5">
        <h1 className="text-xl font-semibold tracking-tight text-balance">{title}</h1>
        {description && <p className="max-w-prose text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * The small uppercase label above a group of rows. Deliberately quieter than a
 * heading — it separates, it doesn't announce.
 */
export function SectionHeader({
  children,
  meta,
  className,
}: {
  children: React.ReactNode;
  /** Counts, timestamps, a filter — anything that qualifies the group. */
  meta?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1", className)}>
      <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        {children}
      </span>
      {meta && <span className="text-xs text-muted-foreground tabular-nums">{meta}</span>}
    </div>
  );
}
