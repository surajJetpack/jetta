"use client";

/**
 * The open conversation: its header (who, where, status, tickets) and the
 * transcript. Presentational — ChatInbox owns the conversation, the hydration
 * flag and the scroll anchor, and passes them in.
 */
import { Fragment, type RefObject } from "react";
import { ArrowLeft, ExternalLink, Paperclip } from "lucide-react";
import { ChatAvatar } from "@/components/jetta/chat-avatar";
import { Button } from "@/components/ui/button";
import { StatusChip } from "@/components/jetta/status-chip";
import { CHIP_BASE, TONE_SOFT } from "@/components/jetta/tone";
import { cn } from "@/lib/utils";
import { dayKey, fmtDateTime, fmtDayLabel, fmtTime, useNow } from "@/lib/format";
import { LABELS, TONES, consoleFileUrl, type Conv } from "./chat-types";

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
    <div className="flex items-center gap-2 py-2" role="separator">
      <span className="h-px flex-1 bg-border" />
      <span className="text-3xs tracking-wide text-muted-foreground uppercase">
        {fmtDayLabel(at, now)}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

export function ConversationHeader({
  detail,
  hydrated,
  zone,
  freshdeskDomain,
  select,
}: {
  detail: Conv;
  hydrated: boolean;
  zone: { short: string; name: string };
  freshdeskDomain: string;
  select: (id: string | null) => void;
}) {
  return (
    <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
      <Button size="sm" variant="ghost" className="md:hidden" onClick={() => select(null)}>
        <ArrowLeft /> Back
      </Button>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">
          {detail.visitor.name || "Anonymous"}{" "}
          {detail.visitor.email ? (
            <span className="text-xs font-normal text-muted-foreground">{detail.visitor.email}</span>
          ) : (
            // There is no pre-chat form: Jetta collects identity in
            // the conversation. Anyone taking over needs to know the
            // collecting is now THEIRS — without an email there is no
            // ticket and no follow-up.
            <span className={cn(CHIP_BASE, TONE_SOFT.warn, "font-medium tracking-normal")}>
              No email yet — get it if you take over
            </span>
          )}
        </p>
        <p className="truncate text-2xs text-muted-foreground">
          {detail.surface}
          {detail.visitor.mondayAccountSlug && ` · ${detail.visitor.mondayAccountSlug}`}
          {detail.visitor.app && ` · ${detail.visitor.app}`}
          {detail.pageUrl && ` · ${detail.pageUrl.replace(/^https?:\/\//, "").slice(0, 40)}`}
        </p>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {hydrated && (
          <span
            className="text-2xs text-muted-foreground"
            title={`Transcript times are in your own zone${zone.name ? ` (${zone.name})` : ""}. The transcript on the Freshdesk ticket is in UTC.`}
          >
            Times in {zone.short}
          </span>
        )}
        <StatusChip tone={TONES[detail.status]}>{LABELS[detail.status]}</StatusChip>
        {/* Whose decision it was. "jetta" here means she closed her own
            loop — either the customer confirmed the fix, or nobody came
            back and the follow-up sweep finished it. */}
        {detail.status === "resolved" && detail.resolvedBy && (
          <span className="text-2xs text-muted-foreground">by {detail.resolvedBy}</span>
        )}
        {detail.ticketId && (
          // Freshdesk, not here. This used to link to /chats/<this
          // conversation> — the page you were already on — while
          // wearing an external-link icon, so the one control that
          // should cross between the two systems went nowhere.
          <a
            href={`https://${freshdeskDomain}/a/tickets/${detail.ticketId}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-2xs text-primary hover:underline"
            title="Open this ticket in Freshdesk"
          >
            Ticket #{detail.ticketId} <ExternalLink className="size-3" aria-hidden />
          </a>
        )}
        {/* A chat that raised two separate problems has two tickets.
            The newest is the live one above; these are the earlier
            ones, shown so a conversation never hides a thread it
            opened. */}
        {detail.previousTicketIds?.map((id) => (
          <a
            key={id}
            href={`https://${freshdeskDomain}/a/tickets/${id}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-2xs text-muted-foreground hover:underline"
            title="An earlier ticket from this conversation"
          >
            Also #{id} <ExternalLink className="size-3" aria-hidden />
          </a>
        ))}
      </div>
    </header>
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
    <div className="flex-1 space-y-2 overflow-y-auto px-3 py-3">
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
              <p className="py-1 text-center text-2xs text-muted-foreground">{m.text}</p>
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
          <span className="size-6 shrink-0" aria-hidden />
        ) : m.author === "visitor" ? (
          <ChatAvatar kind="visitor" name={detail.visitor.name || detail.visitor.email} />
        ) : human ? (
          <ChatAvatar kind="human" name={m.authorName} />
        ) : (
          <ChatAvatar kind="jetta" src={avatars[detail.brandKey ?? "main"]} />
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
                    ? "flex items-end justify-start gap-1.5"
                    : "flex items-end justify-end gap-1.5"
                }
              >
                {m.author === "visitor" && gutter}
                <div
                  className={[
                    "max-w-[78%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap",
                    m.author === "visitor"
                      ? "rounded-bl-sm bg-muted"
                      : human
                        ? "rounded-br-sm border border-primary/40 bg-primary/5"
                        : "rounded-br-sm bg-primary/10",
                  ].join(" ")}
                >
                  {m.author === "agent" && (
                    <p className="mb-0.5 text-3xs tracking-wide text-muted-foreground uppercase">
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
                    "mt-0.5 text-3xs tabular-nums text-muted-foreground",
                    /* Clear of the avatar gutter (a size-6 face plus
                       the gap-1.5) so the time sits under the bubble's
                       own edge rather than under the face. */
                    m.author === "visitor" ? "ps-[30px] text-left" : "pe-[30px] text-right",
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
