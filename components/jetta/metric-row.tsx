/**
 * The headline number strip — arrived / answered / waiting / escalated.
 *
 * Three pages compute a row of counts and each dresses it differently: Today
 * uses bordered tiles, System used a four-column grid of the same, Insights
 * puts them in card headers. This is the one shape, and the point of it is the
 * numbers line up: `tabular-nums` and a shared size mean a column of digits
 * can be compared by eye instead of read one at a time.
 *
 * A metric can carry a tone when its value is itself a state — four visitors
 * waiting is not the same kind of four as four answered — but the label always
 * carries the meaning, so nothing here depends on colour alone.
 */
import { cn } from "@/lib/utils";
import { TONE_TEXT, type Tone } from "./tone";

export interface MetricSpec {
  label: string;
  value: React.ReactNode;
  /** Optional qualifier under the number: "vs 31 yesterday", "3× normal". */
  hint?: React.ReactNode;
  /** Defaults to neutral ink. Use sparingly — a row of colours has no emphasis. */
  tone?: Tone;
  /** Makes the whole metric a button — for opening the records behind the number. */
  onClick?: () => void;
}

export function MetricRow({
  metrics,
  className,
}: {
  metrics: MetricSpec[];
  className?: string;
}) {
  return (
    <dl
      className={cn(
        "grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4",
        metrics.length === 5 && "sm:grid-cols-5",
        className,
      )}
    >
      {metrics.map((m) => (
        <div
          key={m.label}
          className={cn("min-w-0", m.onClick && "group relative -m-1.5 rounded-md p-1.5 transition-colors hover:bg-muted/60")}
        >
          <dt className="truncate text-2xs font-medium tracking-wider text-muted-foreground uppercase">
            {m.label}
          </dt>
          <dd
            className={cn(
              "mt-1 text-2xl leading-none font-semibold tabular-nums",
              m.tone ? TONE_TEXT[m.tone] : "text-foreground",
              m.onClick && "underline decoration-dotted decoration-1 underline-offset-4 group-hover:decoration-solid",
            )}
          >
            {m.value}
          </dd>
          {m.hint && <p className="mt-1 truncate text-xs text-muted-foreground">{m.hint}</p>}
          {m.onClick && (
            // Covers the cell so the label and hint are part of the target; dt/dd can't live inside a <button>.
            <button
              type="button"
              onClick={m.onClick}
              aria-label={`Show the records behind ${m.label}`}
              className="absolute inset-0 rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            />
          )}
        </div>
      ))}
    </dl>
  );
}
