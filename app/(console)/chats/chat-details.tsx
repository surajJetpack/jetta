"use client";

/**
 * The inbox's right pane: who the visitor is, what this conversation is, the
 * tickets it opened and the visitor's other chats.
 *
 * All of this used to be crammed into one grey line under the visitor's name.
 * Someone taking over a chat reads it before typing, so it gets a column of
 * its own on wide screens and stays out of the way on narrow ones.
 */
import type { ReactNode } from "react";
import { ExternalLink, PanelRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { RelativeTime } from "@/components/jetta/relative-time";
import { CHIP_BASE, TONE_SOFT } from "@/components/jetta/tone";
import { cn } from "@/lib/utils";
import { appName } from "@/lib/types";
import { fmtDateTime } from "@/lib/format";
import { LABELS, NO_APP, appOf, type Conv } from "./chat-types";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h2 className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">{title}</h2>
      {children}
    </section>
  );
}

function Fields({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-y-2 text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface ChatDetailsProps {
  detail: Conv;
  /** The same visitor's other conversations, newest first. */
  related: Conv[];
  hydrated: boolean;
  zone: { short: string; name: string };
  freshdeskDomain: string;
  select: (id: string | null) => void;
}

/**
 * Where the details live depends on the room. From 1400px they are a third
 * column, which is what a 13" laptop's ~1440px gives; below that, the
 * conversation would be squeezed to a strip, so they open as a slide-over
 * from the header's Details button instead (ChatDetailsSheet).
 */
export function ChatDetails(props: ChatDetailsProps) {
  return (
    <aside
      aria-label="Visitor details"
      className="hidden w-[280px] shrink-0 flex-col gap-5 overflow-y-auto border-l bg-card p-5 min-[1400px]:flex 2xl:w-[300px]"
    >
      <DetailsBody {...props} />
    </aside>
  );
}

export function ChatDetailsSheet(props: ChatDetailsProps) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button size="sm" variant="outline" className="min-[1400px]:hidden">
          <PanelRight /> Details
        </Button>
      </SheetTrigger>
      <SheetContent className="w-[320px] gap-0 overflow-y-auto sm:max-w-[320px]">
        <SheetHeader className="border-b">
          <SheetTitle>{props.detail.visitor.name || "Anonymous"}</SheetTitle>
          <SheetDescription className="text-xs">Visitor and conversation details</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-5 p-5">
          <DetailsBody {...props} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

function DetailsBody({ detail, related, hydrated, zone, freshdeskDomain, select }: ChatDetailsProps) {
  const v = detail.visitor;
  const page = detail.pageUrl?.replace(/^https?:\/\//, "");
  // The newest ticket first, then the earlier ones: a chat that raised two
  // separate problems has two tickets, and none of them may be hidden.
  const tickets = [
    ...(detail.ticketId ? [detail.ticketId] : []),
    ...[...(detail.previousTicketIds ?? [])].reverse(),
  ];

  return (
    <>
      <Section title="Visitor">
        <Fields
          rows={[
            ["Name", v.name || <span className="text-muted-foreground">Not given</span>],
            [
              "Email",
              v.email || (
                <span className={cn(CHIP_BASE, TONE_SOFT.warn)}>Not collected yet</span>
              ),
            ],
            ...(v.mondayAccountSlug
              ? ([["monday", <span key="m" className="font-mono">{v.mondayAccountSlug}</span>]] as [string, ReactNode][])
              : []),
            ["App", appOf(detail) !== NO_APP ? appName(appOf(detail)) : <span className="text-muted-foreground">Not known</span>],
            ...(page
              ? ([[
                  "Page",
                  <a key="p" href={detail.pageUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline" title={detail.pageUrl}>
                    {page.length > 48 ? `${page.slice(0, 48)}…` : page}
                  </a>,
                ]] as [string, ReactNode][])
              : []),
          ]}
        />
      </Section>

      <div className="h-px bg-border" />

      <Section title="Conversation">
        <Fields
          rows={[
            ["Status", detail.status === "human" && detail.humanAgent ? `With ${detail.humanAgent}` : LABELS[detail.status]],
            ...(detail.status === "resolved" && detail.resolvedBy
              ? ([["Resolved by", detail.resolvedBy]] as [string, ReactNode][])
              : []),
            ["Started", <RelativeTime key="s" at={Math.floor(Date.parse(detail.createdAt) / 1000)} />],
            ["Messages", String(detail.messages.filter((m) => !m.system).length)],
            ["Surface", detail.surface],
            // The transcript's times are the viewer's own; the same
            // conversation's Freshdesk transcript is fixed to UTC.
            ...(hydrated
              ? ([[
                  "Times in",
                  <span key="z" title={`Transcript times are in your own zone${zone.name ? ` (${zone.name})` : ""}. The transcript on the Freshdesk ticket is in UTC.`}>
                    {zone.short}
                  </span>,
                ]] as [string, ReactNode][])
              : []),
          ]}
        />
      </Section>

      <div className="h-px bg-border" />

      <Section title="Tickets">
        {tickets.length === 0 ? (
          <p className="text-xs text-muted-foreground">None yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {tickets.map((id, i) => (
              <li key={id}>
                <a
                  href={`https://${freshdeskDomain}/a/tickets/${id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                  title="Open this ticket in Freshdesk"
                >
                  #{id} <ExternalLink className="size-3" aria-hidden />
                </a>
                {i > 0 && <span className="ml-1.5 text-2xs text-muted-foreground">earlier</span>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {related.length > 0 && (
        <>
          <div className="h-px bg-border" />
          <Section title="Earlier chats">
            <ul className="space-y-2">
              {related.slice(0, 5).map((c) => {
                const first = c.messages.find((m) => m.author === "visitor" && m.text.trim())?.text ?? "No messages";
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => select(c.id)}
                      className="w-full rounded-lg border p-2.5 text-left transition-colors outline-none hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      title={hydrated ? fmtDateTime(c.createdAt) : undefined}
                    >
                      <span className="line-clamp-1 text-xs font-medium">{first}</span>
                      <span className="mt-0.5 block text-2xs text-muted-foreground">
                        <RelativeTime at={Math.floor(Date.parse(c.createdAt) / 1000)} /> · {LABELS[c.status]}
                        {c.ticketId ? ` · #${c.ticketId}` : ""}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Section>
        </>
      )}
    </>
  );
}
