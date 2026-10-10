"use client";

/**
 * The inbox's left pane: search, app and status filters, the sound switch, and
 * the conversation rows. Presentational — every value and handler comes from
 * ChatInbox, which owns the state and the polls.
 */
import { Bell, BellOff, Search } from "lucide-react";
import { ChatAvatar } from "@/components/jetta/chat-avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusChip } from "@/components/jetta/status-chip";
import { EmptyState } from "@/components/jetta/empty-state";
import { RelativeTime } from "@/components/jetta/relative-time";
import { cn } from "@/lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { appName } from "@/lib/types";
import { setChimeEnabled } from "@/components/jetta/chime";
import { ALL_APPS, LABELS, NO_APP, TONES, appOf, type AppOption, type Conv, type Filter } from "./chat-types";

export function ChatList({
  detail,
  query,
  setQuery,
  appOptions,
  app,
  setApp,
  filter,
  setFilter,
  waiting,
  resolvedCount,
  sound,
  visible,
  select,
  abandoned,
}: {
  detail: Conv | null;
  query: string;
  setQuery: (q: string) => void;
  appOptions: AppOption[];
  app: string;
  setApp: (app: string) => void;
  filter: Filter;
  setFilter: (f: Filter) => void;
  waiting: number;
  resolvedCount: number;
  sound: boolean;
  visible: Conv[];
  select: (id: string | null) => void;
  abandoned: number;
}) {
  return (
    <aside className={detail ? "hidden md:block" : "block"}>
      <div className="space-y-2">
        <div className="relative">
          <Search className="absolute top-2.5 left-2.5 size-3.5 text-muted-foreground" aria-hidden />
          <Input
            type="search"
            aria-label="Search chats"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, email or message"
            className="h-9 pl-8 text-xs"
          />
        </div>
        {/* Only worth showing once there is a choice to make: with a single
            app on the board the control is a label that filters nothing. */}
        {appOptions.length > 1 && (
          <Select value={app} onValueChange={setApp}>
            <SelectTrigger size="sm" className="w-full text-xs" aria-label="Filter by app">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_APPS}>All apps</SelectItem>
              {appOptions.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label} · {o.count}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="flex items-start gap-1">
          {/* One segmented control, not five loose buttons: the filters are
              mutually exclusive, and should look like it. */}
          <div
            role="group"
            aria-label="Filter chats"
            // One row that scrolls sideways when the counts make it long, rather than
            // wrapping a lone "Resolved" onto a second line.
            className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto rounded-md border bg-muted/40 p-0.5 [scrollbar-width:none]"
          >
            {(
              [
                ["needs_human", waiting ? `Needs a person · ${waiting}` : "Needs a person"],
                ["open", "With Jetta"],
                ["ticketed", "Ticketed"],
                ["all", "All live"],
                ["resolved", resolvedCount ? `Resolved · ${resolvedCount}` : "Resolved"],
              ] as [Filter, string][]
            ).map(([f, label]) => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                className={cn(
                  "h-6 shrink-0 rounded-sm px-2 text-2xs font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  filter === f
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setFilter(f)}
              >
                {label}
              </button>
            ))}
          </div>
          {/* The chime's off switch lives where the chime is about — and the
              setting is shared with the sidebar's waiting-visitor sound, so
              one bell governs everything that rings. */}
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-7 w-7 p-0"
            aria-label={sound ? "Turn notification sound off" : "Turn notification sound on"}
            title={
              sound
                ? "Sound on — rings when a visitor needs a person or replies to one"
                : "Sound off"
            }
            onClick={() => setChimeEnabled(!sound)}
          >
            {sound ? <Bell /> : <BellOff className="text-muted-foreground" />}
          </Button>
        </div>

        <div className="max-h-[70dvh] space-y-1.5 overflow-y-auto pr-1">
          {visible.length === 0 && (
            <EmptyState
              className="border-0 py-6"
              icon={query ? Search : undefined}
              title={query ? "No chats match that search" : "No chats here"}
              hint={
                app !== ALL_APPS
                  ? `Showing ${appOptions.find((o) => o.value === app)?.label ?? app} only.`
                  : undefined
              }
            />
          )}
          {visible.map((c) => {
            const last = c.messages[c.messages.length - 1];
            const active = c.id === detail?.id;
            return (
              <button
                key={c.id}
                type="button"
                aria-current={active ? "true" : undefined}
                onClick={() => select(c.id)}
                className={cn(
                  "w-full rounded-lg border p-2.5 text-left transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  active ? "border-primary bg-muted" : "hover:bg-muted/50",
                  c.status === "waiting_human" && !active && "border-tone-bad/50",
                )}
              >
                <div className="flex items-center gap-1.5">
                  <ChatAvatar
                    kind="visitor"
                    name={c.visitor.name || c.visitor.email}
                    className="size-5 text-3xs"
                  />
                  <span className="truncate text-xs font-medium">
                    {c.visitor.name || c.visitor.email || "Anonymous"}
                  </span>
                  <span className="ml-auto shrink-0 text-3xs text-muted-foreground">
                    <RelativeTime at={Math.floor(Date.parse(c.lastActivityAt) / 1000)} />
                  </span>
                </div>
                <p className="mt-0.5 line-clamp-1 text-2xs text-muted-foreground">
                  {last?.text ?? "No messages yet"}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  <StatusChip tone={TONES[c.status]}>{LABELS[c.status]}</StatusChip>
                  {/* Which ticket this became. Without it the Ticketed
                      filter is a list of chats with no way to tell them
                      apart from the ticket you are holding. */}
                  {c.ticketId && (
                    <span className="text-3xs tabular-nums text-muted-foreground">#{c.ticketId}</span>
                  )}
                  {c.humanAgent && <span className="text-3xs text-muted-foreground">{c.humanAgent}</span>}
                  {/* Named on the row, not just in the filter: otherwise the
                      only way to check what a chat was attributed to is to
                      filter by each app in turn and see where it lands. */}
                  {appOf(c) !== NO_APP && (
                    <span className="ml-auto shrink-0 text-3xs text-muted-foreground">
                      {appName(appOf(c))}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
          {abandoned > 0 && (
            <p className="px-1 pt-2 text-2xs text-muted-foreground">
              {abandoned} {abandoned === 1 ? "visitor" : "visitors"} opened the chat without sending
              anything.
            </p>
          )}
        </div>
      </div>
    </aside>
  );
}
