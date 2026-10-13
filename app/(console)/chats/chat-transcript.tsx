"use client";

/**
 * The open conversation: its header (who, the actions), the status strip and
 * the transcript. Presentational — ChatInbox owns the conversation, the hydration
 * flag and the scroll anchor, and passes them in.
 */
import { Fragment, type ReactNode, type RefObject } from "react";
import { ArrowLeft, Paperclip } from "lucide-react";
import { ChatAvatar } from "@/components/jetta/chat-avatar";
import { Button } from "@/components/ui/button";
import { RelativeTime } from "@/components/jetta/relative-time";
import { CHIP_BASE, TONE_SOFT } from "@/components/jetta/tone";
import { cn } from "@/lib/utils";
import { dayKey, fmtDateTime, fmtDayLabel, fmtTime, useNow } from "@/lib/format";
import { appName } from "@/lib/types";
import { NO_APP, appOf, consoleFileUrl, type Conv } from "./chat-types";

/**
 * The "Today" / "8 Sep" rule between two days of one conversation.
 *
 * A leaf that owns its own clock, like `RelativeTime`: "Today" goes stale at
 * midnight on an inbox somebody left open overnight, and ticking down here
 * re-renders one line rather than the whole two-pane view.
 *
 * No `suppressHydrationWarning`: the caller renders dividers only once
 * hydrated, so there is no server text for this to disagree with.
 */
function DayDivider({ at }: { at: string }) {
  const now = useNow(60_000);
  return (
    <div className="flex items-center gap-3 py-2" role="separator">
      <span className="h-px flex-1 bg-border" />
      <span className="text-2xs font-medium tracking-wider text-muted-foreground uppercase">
        {fmtDayLabel(at, now)}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/**
 * One line under the header saying who has this conversation right now and
 * what sending a message would do. The status chip said the same thing in a
 * corner; a person about to type needs it where they are looking.
 */
function StatusStrip({ detail }: { detail: Conv }) {
  const since = Math.floor(Date.parse(detail.lastActivityAt) / 1000);
  const strip = {
    waiting_human: {
      cls: "bg-tone-bad-bg text-tone-bad",
      dot: "bg-tone-bad",
      title: (
        <>
          Waiting for a person · <RelativeTime at={since} />
        </>
      ),
      body: "Jetta asked the team to join. Taking over silences her.",
    },
    human: {
      cls: "bg-tone-warn-bg text-tone-warn",
      dot: "bg-tone-warn",
      title: <>With {detail.humanAgent ?? "a person"}</>,
      body: "Jetta is silent until the chat is handed back.",
    },
    open: {
      cls: "bg-tone-info-bg text-tone-info",
      dot: "bg-tone-info",
      title: <>Jetta is answering</>,
      body: "Sending a message takes the chat over from her.",
    },
    ticketed: {
      cls: "bg-muted text-muted-foreground",
      dot: "bg-muted-foreground/60",
      title: <>Ticketed{detail.ticketId ? ` as #${detail.ticketId}` : ""}</>,
      body: "The visitor is being answered by email. Jetta still replies here.",
    },
    resolved: {
      cls: "bg-tone-good-bg text-tone-good",
      dot: "bg-tone-good",
      title: <>Resolved{detail.resolvedBy ? ` by ${detail.resolvedBy}` : ""}</>,
      body: "A new message from the visitor reopens it.",
    },
  }[detail.status];
  return (
    <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b px-4 py-2 text-xs sm:px-5", strip.cls)}>
      <span className={cn("size-2 shrink-0 rounded-full", strip.dot)} aria-hidden />
      <span className="font-semibold">{strip.title}</span>
      <span className="opacity-90">{strip.body}</span>
    </div>
  );
}

export function ConversationHeader({
  detail,
  select,
  actions,
  freshdeskDomain,
}: {
  detail: Conv;
  select: (id: string | null) => void;
  freshdeskDomain: string;
  /** The take-over / resolve / ticket controls, owned by ChatInbox. */
  actions: ReactNode;
}) {
  return (
    <>
      <header className="flex flex-wrap items-center gap-3 border-b bg-card px-4 py-3 sm:px-5">
        <Button size="sm" variant="ghost" className="md:hidden" onClick={() => select(null)}>
          <ArrowLeft /> Back
        </Button>
        <ChatAvatar kind="visitor" name={detail.visitor.name || detail.visitor.email} className="size-10 text-xs" />
        <div className="min-w-0">
          <p className="truncate text-base font-semibold">{detail.visitor.name || "Anonymous"}</p>
          <p className="truncate text-xs text-muted-foreground">
            {detail.visitor.email ? (
              detail.visitor.email
            ) : (
              // There is no pre-chat form: Jetta collects identity in the
              // conversation. Anyone taking over needs to know the collecting
              // is now THEIRS — without an email there is no ticket and no
              // follow-up.
              <span className={cn(CHIP_BASE, TONE_SOFT.warn, "font-medium tracking-normal")}>
                No email yet. Get it if you take over.
              </span>
            )}
            {appOf(detail) !== NO_APP && ` · ${appName(appOf(detail))}`}
            {/* The details pane only fits on wide screens; below that, the two
                things you'd otherwise lose ride along here. */}
            <span className="min-[1500px]:hidden">
              {detail.visitor.mondayAccountSlug && (
                <>
                  {" "}· <span className="font-mono">{detail.visitor.mondayAccountSlug}</span>
                </>
              )}
              {detail.ticketId && (
                <>
                  {" "}·{" "}
                  <a
                    href={`https://${freshdeskDomain}/a/tickets/${detail.ticketId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline"
                    title="Open this ticket in Freshdesk"
                  >
                    Ticket #{detail.ticketId}
                  </a>
                </>
              )}
            </span>
          </p>
        </div>
        <div className="ml-auto">{actions}</div>
      </header>
      <StatusStrip detail={detail} />
    </>
  );
}

export function Transcript({
  detail,
  hydrated,
  zone,
  avatars,
  endRef,
}: {
  detail: Conv;
  hydrated: boolean;
  zone: { short: string; name: string };
  avatars: { main?: string; getsign?: string };
  endRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-muted/30 px-4 py-5 sm:px-6">
      {detail.messages.map((m, i, arr) => {
        /*
         * A divider wherever the calendar day turns over.
         *
         * Not decoration: a chat is not always one sitting. A ticketed
         * conversation keeps taking messages long after the first
         * answer, so two bubbles an inch apart can be days apart — and
         * a bare "09:14" with nothing to sit under is a worse answer
         * than no time at all.
         */
        const prev = arr[i - 1];
        const divider =
          hydrated && (!prev || dayKey(prev.createdAt) !== dayKey(m.createdAt)) ? (
            <DayDivider at={m.createdAt} />
          ) : null;

        if (m.system) {
          return (
            <Fragment key={m.id}>
              {divider}
              <p className="mx-auto w-fit rounded-full bg-muted px-3 py-1 text-center text-2xs text-muted-foreground">
                {m.text}
              </p>
            </Fragment>
          );
        }
        const human = m.via === "human";
        // One face per run of consecutive same-speaker messages, on
        // the run's last bubble; the rest get an equal-width spacer so
        // bubbles stay aligned. Cheaper to read than a face per line.
        // The timestamp rides the same boundary, so a burst of three
        // messages reads as one turn with one clock against it.
        const next = arr[i + 1];
        const runEnds =
          !next ||
          next.system === true ||
          next.author !== m.author ||
          next.via !== m.via ||
          next.authorName !== m.authorName ||
          // Midnight ends a run too, or the divider would split a run
          // whose only timestamp is stranded on the far side of it.
          // Gated: this clause decides whether the gutter holds a face
          // or a spacer, and midnight is not in the same place for the
          // server as it is for the reader.
          (hydrated && dayKey(next.createdAt) !== dayKey(m.createdAt));
        const gutter = !runEnds ? (
          <span className="size-7 shrink-0" aria-hidden />
        ) : m.author === "visitor" ? (
          <ChatAvatar kind="visitor" name={detail.visitor.name || detail.visitor.email} className="size-7" />
        ) : human ? (
          <ChatAvatar kind="human" name={m.authorName} className="size-7" />
        ) : (
          <ChatAvatar kind="jetta" src={avatars[detail.brandKey ?? "main"]} className="size-7" />
        );
        return (
          <Fragment key={m.id}>
            {divider}
            {/* Bubble and time wrapped as one child, so the column's
                space-y-2 separates TURNS while the time stays tucked
                against the bubble it belongs to. */}
            <div>
              <div
                className={
                  m.author === "visitor"
                    ? "flex items-end justify-start gap-2.5"
                    : "flex items-end justify-end gap-2.5"
                }
              >
                {m.author === "visitor" && gutter}
                <div
                  className={[
                    "max-w-[72%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap",
                    m.author === "visitor"
                      ? "rounded-bl-md border bg-card shadow-xs"
                      : human
                        ? "rounded-br-md border border-tone-warn/40 bg-tone-warn-bg"
                        : "rounded-br-md bg-primary/10",
                  ].join(" ")}
                >
                  {m.author === "agent" && (
                    <p
                      className={cn(
                        "mb-1 text-3xs font-semibold tracking-wider uppercase",
                        human ? "text-tone-warn" : "text-primary",
                      )}
                    >
                      {human ? `${m.authorName ?? "Team"} · human` : "Jetta"}
                    </p>
                  )}
                  {m.attachments?.map((a) => (
                    <a
                      key={a.id}
                      href={consoleFileUrl(a.pathname)}
                      target="_blank"
                      rel="noreferrer"
                      className="mb-1.5 block overflow-hidden rounded-md border bg-background"
                      title={`${a.name}${a.description ? ` — ${a.description}` : ""}`}
                    >
                      {a.contentType.startsWith("image/") ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={consoleFileUrl(a.pathname)} alt={a.name} className="max-h-64 w-full object-contain" />
                      ) : (
                        <span className="flex items-center gap-1.5 px-2.5 py-2 text-xs">
                          <Paperclip className="size-3.5" /> {a.name}
                        </span>
                      )}
                    </a>
                  ))}
                  {/* What Jetta was told the image showed. Shown to us and
                      never to the visitor: it is the only way to tell a
                      wrong answer from a wrong reading of the screenshot. */}
                  {m.attachments?.some((a) => a.description) && (
                    <p className="mb-1.5 border-l-2 border-muted-foreground/30 pl-2 text-2xs text-muted-foreground italic">
                      Jetta saw: {m.attachments.map((a) => a.description).filter(Boolean).join(" ")}
                    </p>
                  )}
                  {m.text}
                </div>
                {m.author === "agent" && gutter}
              </div>
              {hydrated && runEnds && (
                <p
                  className={[
                    "mt-1 text-3xs tabular-nums text-muted-foreground",
                    /* Clear of the avatar gutter (a size-6 face plus
                       the gap-1.5) so the time sits under the bubble's
                       own edge rather than under the face. */
                    m.author === "visitor" ? "ps-[38px] text-left" : "pe-[38px] text-right",
                  ].join(" ")}
                  /* Relative time is the LIST's job — "which chat has
                     gone quiet". Inside a transcript the question is
                     when a thing was actually said, so this is the wall
                     clock, with the full date on hover. */
                  title={`${fmtDateTime(m.createdAt)}${zone.short ? ` ${zone.short}` : ""}`}
                >
                  {fmtTime(m.createdAt)}
                </p>
              )}
            </div>
          </Fragment>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
