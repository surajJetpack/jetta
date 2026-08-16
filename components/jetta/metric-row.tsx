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
        <div key={m.label} className="min-w-0">
          <dt className="truncate text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
            {m.label}
          </dt>
          <dd
            className={cn(
              "mt-1 text-2xl leading-none font-semibold tabular-nums",
              m.tone ? TONE_TEXT[m.tone] : "text-foreground",
            )}
          >
            {m.value}
          </dd>
          {m.hint && <p className="mt-1 truncate text-xs text-muted-foreground">{m.hint}</p>}
        </div>
      ))}
    </dl>
  );
}
