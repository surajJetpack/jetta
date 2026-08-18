"use client";

/**
 * Brand filter — everything / GetSign / Jetpack Apps.
 *
 * Reporting is exclusive where retrieval is not (see `matchesBrand` in
 * lib/profiles.ts): GetSign's numbers sit beside the portfolio's, never inside
 * them, because the question these dashboards answer is "which brand is having
 * a bad week". Tickets attributed to neither fall out of both views rather
 * than padding one.
 */
import { Button } from "@/components/ui/button";

export type Brand = "getsign" | "jetpackapps" | null;

const OPTIONS: { value: Brand; label: string }[] = [
  { value: null, label: "All" },
  { value: "getsign", label: "GetSign" },
  { value: "jetpackapps", label: "Jetpack Apps" },
];

export function BrandFilter({
  value,
  onChange,
  disabled,
}: {
  value: Brand;
  onChange: (b: Brand) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex gap-1.5">
      {OPTIONS.map((o) => (
        <Button
          key={o.label}
          type="button"
          size="sm"
          variant={value === o.value ? "default" : "outline"}
          disabled={disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}

/** Query suffix for the admin APIs — "" when nothing is filtered. */
export function brandQuery(brand: Brand): string {
  return brand ? `?brand=${brand}` : "";
}
