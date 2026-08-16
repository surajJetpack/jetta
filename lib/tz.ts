/**
 * Calendar-day helpers in the support timezone.
 *
 * Everything else in the app buckets by UTC day (`lib/series.ts`), and that is
 * the right default — it keeps /analytics and /today agreeing about what a day
 * is. But "what came in on Saturday" is a question about a *support* day, and
 * Freshdesk stores `created_at` in UTC: on IST a Saturday spans two UTC days,
 * and a naive UTC filter answers a slightly different question than the one
 * asked. So the timezone is configurable, defaults to UTC, and every surface
 * that uses it says which zone it used.
 */
import { config } from "./config";

let warnedBadZone = false;

/**
 * The configured zone, or UTC if it isn't a real IANA name. An unparseable
 * JETTA_TZ must not take down a lookup — Intl throws on a bad zone, and this is
 * called from inside tool execution where the failure would surface as "I
 * couldn't find anything" rather than as the typo it actually is.
 */
export function supportTimeZone(): string {
  const name = config.timezone;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: name });
    return name;
  } catch {
    if (!warnedBadZone) {
      warnedBadZone = true;
      console.warn(`JETTA_TZ="${name}" is not a valid IANA timezone — falling back to UTC.`);
    }
    return "UTC";
  }
}

/** Calendar day ("2026-08-15") of an instant, in the given zone. en-CA is ISO-ordered. */
export function zonedDayKey(at: Date, timeZone = supportTimeZone()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** Short weekday ("Sat") of an instant, in the given zone. */
export function zonedWeekday(at: Date, timeZone = supportTimeZone()): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(at);
}

/** Shift a "YYYY-MM-DD" day key by whole days. Used to widen a query window. */
export function shiftDayKey(day: string, days: number): string {
  const at = new Date(`${day}T00:00:00Z`);
  // A malformed day is returned untouched: it will fail the API's own date
  // validation with a message that names the field, which is far more useful
  // than "Invalid Date" arriving in the query string.
  if (Number.isNaN(at.getTime())) return day;
  return new Date(at.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/** Today, as Jetta should describe it to a colleague: "Sunday 2026-08-16 (UTC)". */
export function todayInWords(now = new Date()): string {
  const zone = supportTimeZone();
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long" }).format(now);
  return `${weekday} ${zonedDayKey(now, zone)} (${zone})`;
}
