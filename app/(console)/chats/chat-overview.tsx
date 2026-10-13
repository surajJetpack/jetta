"use client";

/**
 * What the conversation pane shows when no conversation is open.
 *
 * It used to say "Pick a conversation" across two thirds of the screen. The
 * pane is the biggest thing on the page, so it now answers the question you
 * opened the inbox with — is anyone waiting? — and offers the one chat most
 * worth opening.
 */
import { ChatAvatar } from "@/components/jetta/chat-avatar";
import { RelativeTime } from "@/components/jetta/relative-time";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { appName } from "@/lib/types";
import { dayKey } from "@/lib/format";
import { NO_APP, appOf, type Conv } from "./chat-types";

export function InboxOverview({
  list,
  inApp,
  hydrated,
  select,
}: {
  list: Conv[];
  /** The app filter, so the numbers describe the same chats as the list. */
  inApp: (c: Conv) => boolean;
  hydrated: boolean;
  select: (id: string | null) => void;
}) {
  const live = list.filter((c) => c.messages.length > 0 && inApp(c));
  const waiting = live
    .filter((c) => c.status === "waiting_human")
    .sort((a, b) => Date.parse(a.lastActivityAt) - Date.parse(b.lastActivityAt));
  const withJetta = live.filter((c) => c.status === "open").length;
  // "Today" is the viewer's day, which the server cannot know: the count
  // waits for hydration rather than rendering the server's guess.
  const today = hydrated ? dayKey(new Date().toISOString()) : null;
  const resolvedToday = today
    ? live.filter((c) => c.status === "resolved" && c.resolvedAt && dayKey(c.resolvedAt) === today).length
    : null;

  // Someone waiting beats everything; otherwise the latest live activity.
  const next =
    waiting[0] ??
    live
      .filter((c) => c.status !== "resolved")
      .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt))[0];

  const tiles: { label: string; n: number | null; tone?: string }[] = [
    { label: "Waiting", n: waiting.length, tone: waiting.length ? "text-tone-bad" : undefined },
    { label: "With Jetta", n: withJetta },
    { label: "Resolved today", n: resolvedToday },
  ];

  return (
    <div className="flex flex-1 items-center justify-center bg-muted/30 p-8">
      <div className="flex w-full max-w-md flex-col gap-3.5">
        <h2 className="text-base font-semibold">Right now</h2>
        <div className="grid grid-cols-3 gap-2.5">
          {tiles.map((t) => (
            <div key={t.label} className="rounded-lg border bg-card px-3.5 py-3">
              <p className="text-2xs text-muted-foreground">{t.label}</p>
              <p className={cn("mt-0.5 text-2xl font-semibold tabular-nums", t.tone)}>{t.n ?? "–"}</p>
            </div>
          ))}
        </div>
        {next && (
          <div className="flex items-center gap-3 rounded-lg border bg-card p-3.5">
            <ChatAvatar kind="visitor" name={next.visitor.name || next.visitor.email} className="size-9 text-2xs" />
            <div className="min-w-0 flex-1">
              <p className={cn("text-2xs", next.status === "waiting_human" ? "font-semibold text-tone-bad" : "text-muted-foreground")}>
                {next.status === "waiting_human" ? (
                  <>
                    Waiting longest · <RelativeTime at={Math.floor(Date.parse(next.lastActivityAt) / 1000)} />
                  </>
                ) : (
                  "Most recent activity"
                )}
              </p>
              <p className="truncate text-sm font-semibold">
                {next.visitor.name || next.visitor.email || "Anonymous"}
                {appOf(next) !== NO_APP && (
                  <span className="font-normal text-muted-foreground"> · {appName(appOf(next))}</span>
                )}
              </p>
            </div>
            <Button size="sm" variant={next.status === "waiting_human" ? "default" : "outline"} onClick={() => select(next.id)}>
              Open
            </Button>
          </div>
        )}
        <p className="text-xs text-muted-foreground">Pick a conversation on the left to read it or take it over.</p>
      </div>
    </div>
  );
}
