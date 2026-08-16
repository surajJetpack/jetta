/**
 * The console's dense row language.
 *
 * Nearly everything here is a list of things that happened — tickets, chats,
 * events, articles, runs — and each of those lists was previously built out of
 * padded, bordered cards. Cards are the right object for a handful of items
 * and the wrong one for forty: they cost roughly three times the vertical
 * space per item and give a scanning reader no column to run their eye down.
 *
 * These are the replacement. A DataList is a hairline-separated stack; a
 * DataRow is one line of it, with an optional second line for detail. Rows
 * link when there is somewhere to go and are plain divs when there isn't,
 * because a row that highlights on hover and then does nothing is a bug that
 * looks like a design.
 */
import Link from "next/link";
import { cn } from "@/lib/utils";

export function DataList({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn("divide-y", className)}>{children}</div>;
}

export function DataRow({
  href,
  external,
  icon,
  title,
  detail,
  meta,
  className,
}: {
  /** Omit when the row has nowhere to go — it renders as a plain row. */
  href?: string;
  /** Opens in a new tab; used for Freshdesk and monday links. */
  external?: boolean;
  /** A lucide icon element, sized by the row. */
  icon?: React.ReactNode;
  title: React.ReactNode;
  /** The second line: subject, message, reason. Truncated to one line. */
  detail?: React.ReactNode;
  /** Right-hand side: chips, counts, a timestamp. */
  meta?: React.ReactNode;
  className?: string;
}) {
  const body = (
    <>
      {icon && (
        <span className="mt-0.5 shrink-0 text-muted-foreground [&_svg]:size-4" aria-hidden>
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{title}</span>
        {detail && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{detail}</span>}
      </span>
      {meta && (
        <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 text-xs text-muted-foreground tabular-nums">
          {meta}
        </span>
      )}
    </>
  );

  const base = "flex items-start gap-2.5 py-2 first:pt-0 last:pb-0";
  if (!href) return <div className={cn(base, className)}>{body}</div>;

  const interactive = cn(
    base,
    "-mx-2 rounded-md px-2 transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
    className,
  );
  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={interactive}>
        {body}
      </a>
    );
  }
  return (
    <Link href={href} className={interactive}>
      {body}
    </Link>
  );
}
