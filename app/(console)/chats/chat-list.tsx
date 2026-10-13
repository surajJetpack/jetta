"use client";

/**
 * The inbox's left pane: title, search, status tabs, app filter, the sound
 * switch, and the conversation rows. Presentational — every value and handler
 * comes from ChatInbox, which owns the state and the polls.
 */
import Link from "next/link";
import { Bell, BellOff, Check, Code2, Search, Settings2 } from "lucide-react";
import { ChatAvatar } from "@/components/jetta/chat-avatar";
import { Button } from "@/components/ui/button";
import { StatusChip } from "@/components/jetta/status-chip";
import { EmptyState } from "@/components/jetta/empty-state";
import { RelativeTime } from "@/components/jetta/relative-time";
import { cn } from "@/lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { appName } from "@/lib/types";
import { setChimeEnabled } from "@/components/jetta/chime";
import {
  ALL_APPS,
  LABELS,
  NO_APP,
  TONES,
  appOf,
  type AppOption,
  type Conv,
  type Filter,
} from "./chat-types";

/** The presence dot on a row's avatar, one colour per status. */
const DOT: Record<Conv["status"], string> = {
  waiting_human: "bg-tone-bad",
  human: "bg-tone-warn",
  open: "bg-tone-info",
  resolved: "bg-tone-good",
  ticketed: "bg-muted-foreground/50",
};

export type FilterCounts = Record<Filter, number>;

/**
 * The views, stacked like mail folders. They were five tabs in one row, which
 * did not fit a 300px column: the last ones were cut off behind a sideways
 * scroll. "All live" sits under a rule because it is the union of the three
 * above it, not a fourth bucket.
 */
const VIEWS: { f: Filter; label: string; dot: string; ruleAbove?: boolean }[] = [
  { f: "needs_human", label: "Needs a person", dot: "bg-tone-bad" },
  { f: "open", label: "With Jetta", dot: "bg-tone-info" },
  { f: "ticketed", label: "Ticketed", dot: "bg-muted-foreground/50" },
  { f: "all", label: "All live", dot: "bg-foreground/70", ruleAbove: true },
  { f: "resolved", label: "Resolved", dot: "bg-tone-good" },
];

/** What an empty view says instead of "No chats here". */
function EmptyView({
  filter,
  query,
  counts,
  setFilter,
  appLabel,
}: {
  filter: Filter;
  query: string;
  counts: FilterCounts;
  setFilter: (f: Filter) => void;
  appLabel?: string;
}) {
  const scope = appLabel ? ` in ${appLabel}` : "";
  if (query) {
    return (
      <EmptyState
        className="border-0 py-10"
        icon={Search}
        title="No chats match that search"
        hint={`Searching ${VIEWS.find((v) => v.f === filter)?.label ?? "this view"}${scope}.`}
      />
    );
  }
  if (filter === "needs_human") {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
        <span className="flex size-11 items-center justify-center rounded-full bg-tone-good-bg text-tone-good">
          <Check className="size-5" aria-hidden />
        </span>
        <p className="text-sm font-semibold">Nobody is waiting</p>
        <p className="max-w-56 text-xs text-muted-foreground">
          {counts.open > 0
            ? `Jetta is handling ${counts.open} ${counts.open === 1 ? "chat" : "chats"}${scope} on her own right now.`
            : `No live chats${scope} right now.`}
        </p>
        {counts.open > 0 && (
          <button
            type="button"
            onClick={() => setFilter("open")}
            className="text-xs font-medium text-primary outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            Show With Jetta
          </button>
        )}
      </div>
    );
  }
  const title = {
    open: "Jetta has no live chats",
    ticketed: "Nothing ticketed",
    all: "No live chats",
    resolved: "Nothing resolved yet",
    needs_human: "",
  }[filter];
  return <EmptyState className="border-0 py-10" title={title} hint={appLabel ? `Showing ${appLabel} only.` : undefined} />;
}

export function ChatList({
  detail,
  query,
  setQuery,
  appOptions,
  app,
  setApp,
  filter,
  setFilter,
  counts,
  sound,
  visible,
  select,
  abandoned,
  isAdmin,
}: {
  detail: Conv | null;
  query: string;
  setQuery: (q: string) => void;
  appOptions: AppOption[];
  app: string;
  setApp: (app: string) => void;
  filter: Filter;
  setFilter: (f: Filter) => void;
  counts: FilterCounts;
  sound: boolean;
  visible: Conv[];
  select: (id: string | null) => void;
  abandoned: number;
  isAdmin: boolean;
}) {
  return (
    <aside
      aria-label="Conversations"
      className={cn(
        "min-h-0 w-full flex-col border-r md:flex md:w-[300px] md:shrink-0 2xl:w-[340px]",
        detail ? "hidden" : "flex",
      )}
    >
      <div className="space-y-2 px-4 pt-4 pb-2">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold">Inbox</h1>
          <div className="ml-auto flex items-center gap-1">
            {isAdmin && (
              <>
                <Button size="icon" variant="ghost" className="size-8" asChild>
                  <Link href="/chats/settings" aria-label="Chat settings" title="Chat settings">
                    <Settings2 />
                  </Link>
                </Button>
                <Button size="icon" variant="ghost" className="size-8" asChild>
                  <Link href="/chats/install" aria-label="Install the widget" title="Install the widget">
                    <Code2 />
                  </Link>
                </Button>
              </>
            )}
            {/* The chime's off switch lives where the chime is about — and the
                setting is shared with the sidebar's waiting-visitor sound, so
                one bell governs everything that rings. */}
            <Button
              size="icon"
              variant="outline"
              className="size-8"
              aria-label={sound ? "Turn notification sound off" : "Turn notification sound on"}
              title={
                sound
                  ? "Sound on: rings when a visitor needs a person or replies to one"
                  : "Sound off"
              }
              onClick={() => setChimeEnabled(!sound)}
            >
              {sound ? <Bell /> : <BellOff className="text-muted-foreground" />}
            </Button>
          </div>
        </div>

        <nav aria-label="Views" className="-mx-1 flex flex-col gap-px">
          {VIEWS.map(({ f, label, dot, ruleAbove }) => {
            const on = filter === f;
            const n = counts[f];
            return (
              <div key={f}>
                {ruleAbove && <div className="mx-1 my-1.5 h-px bg-border" />}
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => setFilter(f)}
                  className={cn(
                    "flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    on ? "bg-primary/10 font-semibold text-foreground" : "font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                >
                  <span className={cn("size-2 shrink-0 rounded-full", dot)} aria-hidden />
                  <span className="flex-1 text-left">{label}</span>
                  <span
                    className={cn(
                      "text-xs tabular-nums",
                      // Solid red only for someone waiting: the one count on
                      // this page that has a person sitting behind it.
                      f === "needs_human" && n > 0
                        ? "rounded-full bg-tone-bad px-1.5 font-bold text-background"
                        : "text-muted-foreground",
                    )}
                  >
                    {n}
                  </span>
                </button>
              </div>
            );
          })}
        </nav>
      </div>

      <div className="space-y-2 border-b px-4 pt-1 pb-3">
        <label className="flex h-9 items-center gap-2 rounded-lg border bg-muted/40 px-2.5 text-muted-foreground focus-within:ring-[3px] focus-within:ring-ring/50">
          <Search className="size-3.5 shrink-0" aria-hidden />
          <input
            type="search"
            aria-label="Search chats"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search in ${VIEWS.find((v) => v.f === filter)?.label ?? "chats"}`}
            className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>

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
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {visible.length === 0 && (
          <EmptyView
            filter={filter}
            query={query}
            counts={counts}
            setFilter={setFilter}
            appLabel={app !== ALL_APPS ? (appOptions.find((o) => o.value === app)?.label ?? app) : undefined}
          />
        )}
        {visible.map((c) => {
          const last = c.messages[c.messages.length - 1];
          const active = c.id === detail?.id;
          const name = c.visitor.name || c.visitor.email || "Anonymous";
          return (
            <button
              key={c.id}
              type="button"
              aria-current={active ? "true" : undefined}
              onClick={() => select(c.id)}
              className={cn(
                "mb-0.5 flex w-full gap-3 rounded-lg p-3 text-left transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                active ? "bg-primary/10" : "hover:bg-muted/60",
              )}
            >
              <span className="relative h-fit shrink-0">
                <ChatAvatar kind="visitor" name={c.visitor.name || c.visitor.email} className="size-9 text-2xs" />
                <span
                  className={cn("absolute -right-px -bottom-px size-3 rounded-full border-2 border-card", DOT[c.status])}
                  aria-hidden
                />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1.5">
                  <span className="truncate text-sm font-semibold">{name}</span>
                  <RelativeTime
                    at={Math.floor(Date.parse(c.lastActivityAt) / 1000)}
                    className={cn(
                      "ml-auto shrink-0 text-2xs",
                      c.status === "waiting_human" ? "font-semibold text-tone-bad" : "text-muted-foreground",
                    )}
                  />
                </span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {last?.text ?? "No messages yet"}
                </span>
                <span className="mt-1.5 flex items-center gap-1.5">
                  <StatusChip tone={TONES[c.status]}>
                    {c.status === "human" && c.humanAgent ? `With ${c.humanAgent}` : LABELS[c.status]}
                  </StatusChip>
                  {/* Named on the row, not just in the filter: otherwise the
                      only way to check what a chat was attributed to is to
                      filter by each app in turn and see where it lands. */}
                  {appOf(c) !== NO_APP && (
                    <span className="truncate text-2xs text-muted-foreground">{appName(appOf(c))}</span>
                  )}
                  {/* Which ticket this became. Without it the Ticketed
                      filter is a list of chats with no way to tell them
                      apart from the ticket you are holding. */}
                  {c.ticketId && (
                    <span className="ml-auto shrink-0 text-2xs tabular-nums text-muted-foreground">
                      #{c.ticketId}
                    </span>
                  )}
                </span>
              </span>
            </button>
          );
        })}
        {abandoned > 0 && (
          <p className="px-3 pt-2 pb-1 text-2xs text-muted-foreground">
            {abandoned} {abandoned === 1 ? "visitor" : "visitors"} opened the chat without sending
            anything.
          </p>
        )}
      </div>
    </aside>
  );
}

