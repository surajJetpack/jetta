"use client";

/** What customers asked about — the themes Jetta labelled, with last period's count. */
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/jetta/empty-state";
import { appName } from "@/lib/types";
import type { SupportHealth } from "@/lib/support-health";
import { pct, type Open } from "./health-shared";

export function Topics({ h, open }: { h: SupportHealth; open: Open }) {
  const max = Math.max(1, ...h.topics.map((t) => t.count));
  return (
    <Card id="themes" className="scroll-mt-16 gap-2 py-4">
      <CardHeader className="px-4">
        <CardTitle>What customers asked about</CardTitle>
        <CardDescription className="text-xs">
          Last 28 days, by theme. {h.topicCoverage != null && `${pct(h.topicCoverage)} of tickets carry a theme.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-4">
        {h.topics.length ? (
          <ul className="grid gap-2">
            {h.topics.map((t) => (
              <li
                key={t.topic}
                className="relative -mx-1.5 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-md px-1.5 py-1 hover:bg-muted/60"
              >
                <button
                  type="button"
                  aria-label={`Show tickets about ${t.topic}`}
                  className="absolute inset-0 rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  onClick={() =>
                    open({
                      title: t.topic.charAt(0).toUpperCase() + t.topic.slice(1),
                      description: "Tickets from the last 28 days Jetta labelled with this theme.",
                      drill: { kind: "topic", topic: t.topic },
                    })
                  }
                />
                <div className="min-w-0">
                  <p className="truncate text-sm first-letter:uppercase">{t.topic}</p>
                  {t.apps.length > 0 && (
                    <p className="truncate text-xs text-muted-foreground">{t.apps.map(appName).join(", ")}</p>
                  )}
                </div>
                <span className="text-sm tabular-nums">
                  {t.count}
                  {t.previous !== t.count && (
                    <span className="ml-1 text-xs text-muted-foreground">(was {t.previous})</span>
                  )}
                </span>
                <div className="col-span-2 h-1 rounded-full bg-muted">
                  <div className="h-1 rounded-full bg-chart-1" style={{ width: `${(t.count / max) * 100}%` }} />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No themes yet" />
        )}
      </CardContent>
    </Card>
  );
}
