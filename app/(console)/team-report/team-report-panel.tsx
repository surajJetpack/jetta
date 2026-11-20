"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ClipboardList, ExternalLink, TriangleAlert, X } from "lucide-react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MetricRow, type MetricSpec } from "@/components/jetta/metric-row";
import { CellLink } from "@/components/jetta/cell-link";
import { EmptyState } from "@/components/jetta/empty-state";
import { DEV_FRESH_H, fmtHours, isListId, JETTA_WHO, LIST_LABEL, listKey, STALE_AFTER_H, type ListId } from "@/lib/team-report-shared";
import type { DevAction, ListItem, PersonReport, ReplyAction, TeamReport } from "@/lib/team-report";

interface Payload {
  report: TeamReport;
  ticketUrlBase: string;
  /** The newest day there is a report for (yesterday in the report's timezone). */
  latestDay: string;
  /** Whether the Slack post is switched on. */
  posting: boolean;
}

interface Pick {
  who: string;
  list: ListId;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const shiftDay = (day: string, by: number) => new Date(Date.parse(`${day}T00:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10);
const dayLabel = (day: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(new Date(`${day}T12:00:00Z`));
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

const DEV_LABEL: [DevAction["kind"], string, string][] = [
  ["relay", "Relay dev update", "Developers answered or handed the item back, and nobody has written to the customer since."],
  ["ask", "Dev needs customer info", "The item is set to Waiting Customer or Need more info, and the customer has not been asked since."],
  ["fixed", "Fixed, tell customer", "The item was resolved in the last 7 days and the ticket is still open with no reply since."],
  ["board", "Handed back on dev board", "Developers handed the item back and Jetta knows of no ticket for it."],
];

/** The error a reader sees when a request fails; the raw status goes to the console. */
function requestFailed(r: Response): string {
  console.error(`${r.url} → HTTP ${r.status}`);
  if (r.status === 401) return "Your session has expired. Sign in again.";
  if (r.status === 403) return "You don't have access to this.";
  return "The server couldn't load this. Try again in a moment.";
}

export default function TeamReportPanel({ initial = {} }: { initial?: { day?: string; who?: string; list?: string } }) {
  const [day, setDay] = useState<string | null>(DAY.test(initial.day ?? "") ? (initial.day as string) : null);
  const [pick, setPick] = useState<Pick | null>(initial.who && isListId(initial.list) ? { who: initial.who, list: initial.list } : null);
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // The newest request wins: stepping through days quickly must not land an older day last.
  const reqId = useRef(0);

  const load = useCallback(() => {
    const id = ++reqId.current;
    fetch(`/api/admin/team-report?format=json${day ? `&day=${day}` : ""}`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(requestFailed(r));
        const d = (await r.json()) as Payload;
        if (id !== reqId.current) return;
        setData(d);
        setErr(null);
      })
      .catch((e) => id === reqId.current && setErr(e instanceof Error ? e.message : String(e)));
  }, [day]);
  useEffect(() => {
    load();
  }, [load]);

  // The address always names what is on screen, so it can be copied or sent as it is.
  const shownDay = data?.report.day ?? day;
  useEffect(() => {
    if (!shownDay) return;
    const q = new URLSearchParams({ day: shownDay, ...(pick ? { who: pick.who, list: pick.list } : {}) });
    window.history.replaceState(null, "", `/team-report?${q}`);
  }, [shownDay, pick]);

  // Arriving from a link, or clicking a count: bring the list into view.
  const loaded = !!data;
  useEffect(() => {
    if (pick && loaded) requestAnimationFrame(() => listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [pick, loaded]);

  if (err && !data) {
    return (
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertTitle>{err}</AlertTitle>
      </Alert>
    );
  }
  if (!data) {
    return (
      <div className="grid gap-4">
        <Skeleton className="h-20" />
        <Skeleton className="h-48" />
        <Skeleton className="h-72" />
      </div>
    );
  }

  const { report: r, ticketUrlBase, latestDay } = data;
  const go = (to: string) => {
    setPick(null);
    setDay(to);
  };
  const open = (who: string, list: ListId) => setPick({ who, list });
  const ticketUrl = (id: number) => `${ticketUrlBase}${id}`;
  const nameOf = (who: string) => (who === JETTA_WHO ? "Jetta" : (r.people.find((p) => p.key === who)?.name ?? who));

  const t = r.team;
  const metrics: MetricSpec[] = [
    { label: "New tickets", value: t.newTickets },
    { label: "Answered", value: t.answered, hint: t.newTickets ? `of ${t.newTickets}` : undefined },
    { label: "First reply", value: t.firstReplyH != null ? fmtHours(t.firstReplyH) : "–", hint: "median" },
    { label: "Waiting on us", value: t.owed, hint: "right now" },
  ];

  const { reply, stale, dev, devOlder } = r.actions;
  const anyDraft = [...reply, ...stale, ...dev].some((a) => a.draftReady);
  const jetta = jettaCells(r, open);
  const rows: { name: string; group: "support" | "other"; cells: React.ReactNode[] }[] = [
    ...r.people.map((p) => ({ name: p.name, group: p.group, cells: personCells(p, open) })),
    ...(jetta ? [{ name: "Jetta", group: "support" as const, cells: jetta }] : []),
  ].sort((a, b) => a.name.localeCompare(b.name));
  const items = pick ? (r.lists[listKey(pick.who, pick.list)] ?? []) : [];
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: r.tz, hour: "2-digit", minute: "2-digit" });

  return (
    <div className="grid min-w-0 gap-5 [&>*]:min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" className="size-8" aria-label="Previous day" onClick={() => go(shiftDay(r.day, -1))}>
            <ChevronLeft />
          </Button>
          <Button variant="outline" size="icon" className="size-8" aria-label="Next day" disabled={r.day >= latestDay} onClick={() => go(shiftDay(r.day, 1))}>
            <ChevronRight />
          </Button>
          <span className="ml-2 text-sm font-medium">{dayLabel(r.day)}</span>
          <span className="text-xs text-muted-foreground">({r.tz} day)</span>
        </div>
        {r.day !== latestDay && (
          <Button variant="ghost" size="sm" onClick={() => go(latestDay)}>
            Latest
          </Button>
        )}
      </div>

      <MetricRow metrics={metrics} />

      {pick && (
        <Card id="list" ref={listRef} className="scroll-mt-16 py-4">
          <CardHeader className="px-4">
            <CardTitle>
              {nameOf(pick.who)}: {LIST_LABEL[pick.list]}
            </CardTitle>
            <CardDescription className="text-xs">
              {plural(items.length, "item")} on {dayLabel(r.day)}, newest first. Each opens in Freshdesk, monday or where it happened.
            </CardDescription>
            <CardAction>
              <Button variant="ghost" size="icon" className="size-7" aria-label="Close list" onClick={() => setPick(null)}>
                <X />
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="px-4">
            {items.length ? (
              <ul className="divide-y">
                {items.map((it, i) => (
                  <ListRow key={i} it={it} at={it.at != null ? time.format(new Date(it.at)) : ""} href={it.ticketId != null ? ticketUrl(it.ticketId) : it.url} />
                ))}
              </ul>
            ) : (
              <EmptyState icon={ClipboardList} title="Nothing on this list for this day" hint="The count may be from another day, or the records behind it are older than the stores keep." />
            )}
          </CardContent>
        </Card>
      )}

      <Card id="to-do" className="scroll-mt-16 py-4">
        <CardHeader className="px-4">
          <CardTitle>To do</CardTitle>
          <CardDescription className="text-xs">
            Customers waiting more than 4 hours, and developer updates nobody has passed on. Worked out now, not as of {dayLabel(r.day)}.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-4">
          {reply.length || stale.length || dev.length || devOlder ? (
            <Table>
              <TableBody>
                {reply.length > 0 && (
                  <TodoRow label="Reply" why="The customer wrote last and has waited more than 4 hours.">
                    {reply.map((a) => (
                      <Waiting key={a.id} a={a} href={ticketUrl(a.id)} />
                    ))}
                  </TodoRow>
                )}
                {stale.length > 0 && (
                  <TodoRow label={`Reply or close (${Math.round(STALE_AFTER_H / 24)}d+)`} why="The customer wrote last and nobody has answered for over two weeks.">
                    {stale.map((a) => (
                      <Waiting key={a.id} a={a} href={ticketUrl(a.id)} />
                    ))}
                  </TodoRow>
                )}
                {DEV_LABEL.map(([kind, label, why]) => {
                  const of = dev.filter((a) => a.kind === kind);
                  if (!of.length) return null;
                  return (
                    <TodoRow key={kind} label={label} why={why}>
                      {of.map((a) => (
                        <DevUpdate key={a.itemId} a={a} ticketHref={a.ticketId != null ? ticketUrl(a.ticketId) : undefined} />
                      ))}
                    </TodoRow>
                  );
                })}
                {devOlder > 0 && (
                  <TodoRow label="Older on dev board" why="Handed back to support long enough ago that it is counted, not listed.">
                    <a href="/dev-board" className="underline decoration-dotted underline-offset-4 hover:decoration-solid">
                      {plural(devOlder, "dev item")} handed back {Math.round(DEV_FRESH_H / 24)}d+ ago
                    </a>
                  </TodoRow>
                )}
              </TableBody>
            </Table>
          ) : (
            <EmptyState icon={ClipboardList} title="Nothing to do" hint="Nobody has waited more than 4 hours and there is no developer update to pass on." />
          )}
          {anyDraft && <p className="mt-3 text-xs text-muted-foreground">Draft ready: Jetta&apos;s suggested reply is already on the ticket.</p>}
        </CardContent>
      </Card>

      <Card id="team" className="scroll-mt-16 py-4">
        <CardHeader className="px-4">
          <CardTitle>Team</CardTitle>
          <CardDescription className="text-xs">
            Every count opens the list behind it. Alphabetical, not ranked. Status changes and moves on the dev boards are not counted.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-4">
          {rows.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Freshdesk</TableHead>
                  <TableHead>monday dev boards</TableHead>
                  <TableHead>Other</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(
                  [
                    ["support", "Support"],
                    ["other", "Developers and others"],
                  ] as const
                ).map(([group, title]) => {
                  const of = rows.filter((x) => x.group === group);
                  if (!of.length) return null;
                  return [
                    <TableRow key={group} className="hover:bg-transparent">
                      <TableCell colSpan={4} className="pt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {title}
                      </TableCell>
                    </TableRow>,
                    ...of.map((x) => (
                      <TableRow key={x.name}>
                        <TableCell className="font-medium">{x.name}</TableCell>
                        {x.cells.map((c, i) => (
                          <TableCell key={i} className="whitespace-normal">
                            {c}
                          </TableCell>
                        ))}
                      </TableRow>
                    )),
                  ];
                })}
              </TableBody>
            </Table>
          ) : (
            <EmptyState icon={ClipboardList} title="Nothing recorded for anyone that day" hint="A weekend or a holiday, or a day older than the stores keep." />
          )}
        </CardContent>
      </Card>

      {!data.posting && (
        <p className="text-xs text-muted-foreground">
          This report is not being posted to Slack: no channel is set (JETTA_TEAM_REPORT_CHANNEL). The page works either way.
        </p>
      )}
    </div>
  );
}

/** Parts of a cell joined by a middle dot; an empty cell is a dash. */
function Parts({ parts }: { parts: (React.ReactNode | false)[] }) {
  const shown = parts.filter(Boolean);
  if (!shown.length) return <span className="text-muted-foreground">–</span>;
  return (
    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      {shown.map((p, i) => (
        <span key={i} className="inline-flex items-baseline gap-2">
          {i > 0 && <span className="text-muted-foreground" aria-hidden>·</span>}
          <span>{p}</span>
        </span>
      ))}
    </span>
  );
}

type Open = (who: string, list: ListId) => void;

/** A count that opens its list. */
function Count({ n, label, onClick }: { n: number; label: string; onClick: () => void }) {
  return (
    <CellLink n={n} onClick={onClick}>
      {label}
    </CellLink>
  );
}

function personCells(p: PersonReport, open: Open): React.ReactNode[] {
  const fd = p.fd;
  const firstLabel = `${plural(fd.firstReplies, "first reply", "first replies")}${fd.firstReplyH != null ? ` (${fd.firstReplies > 1 ? "median " : ""}${fmtHours(fd.firstReplyH)})` : ""}`;
  return [
    <Parts
      key="fd"
      parts={[
        fd.replies > 0 && <Count n={fd.replies} label={plural(fd.replies, "reply", "replies")} onClick={() => open(p.key, "replies")} />,
        fd.notes > 0 && <Count n={fd.notes} label={plural(fd.notes, "note")} onClick={() => open(p.key, "notes")} />,
        fd.firstReplies > 0 && <Count n={fd.firstReplies} label={firstLabel} onClick={() => open(p.key, "first")} />,
      ]}
    />,
    <Parts
      key="board"
      parts={[
        p.monday.created > 0 && <Count n={p.monday.created} label={`${plural(p.monday.created, "item")} filed`} onClick={() => open(p.key, "filed")} />,
        p.monday.comments > 0 && <Count n={p.monday.comments} label={plural(p.monday.comments, "comment")} onClick={() => open(p.key, "comments")} />,
      ]}
    />,
    <Parts
      key="other"
      parts={[
        p.chat.taken > 0 && (
          <>
            <Count n={p.chat.taken} label={`${plural(p.chat.taken, "chat")} taken`} onClick={() => open(p.key, "chats")} />
            {p.chat.pickupMin != null && <span className="text-muted-foreground"> (in {fmtHours(p.chat.pickupMin / 60)})</span>}
          </>
        ),
        p.chat.actions > 0 && <Count n={p.chat.actions} label={plural(p.chat.actions, "chat action")} onClick={() => open(p.key, "chatActions")} />,
        p.slack.messages > 0 && <Count n={p.slack.messages} label={plural(p.slack.messages, "Slack message")} onClick={() => open(p.key, "slack")} />,
        p.console > 0 && plural(p.console, "console decision"),
      ]}
    />,
  ];
}

/** Jetta's row, or null on a day she has nothing to show. */
function jettaCells(r: TeamReport, open: Open): React.ReactNode[] | null {
  const j = r.jetta;
  const sent = j.replies.first + j.replies.followups;
  const filed = j.devItemsFiled ?? j.handoffs.dev_item;
  if (!sent && !j.drafts && !filed && !j.devComments && !j.handoffs.slack && !j.handoffs.chat) return null;
  return [
    <Parts
      key="fd"
      parts={[
        sent > 0 && <Count n={sent} label={`${plural(sent, "reply", "replies")} sent`} onClick={() => open(JETTA_WHO, "sent")} />,
        j.drafts > 0 && <Count n={j.drafts} label={`${plural(j.drafts, "draft")} written`} onClick={() => open(JETTA_WHO, "drafts")} />,
      ]}
    />,
    <Parts
      key="board"
      parts={[
        filed > 0 && (j.devItemsFiled != null ? <Count n={filed} label={`${plural(filed, "item")} filed`} onClick={() => open(JETTA_WHO, "filed")} /> : `${plural(filed, "item")} filed`),
        j.devComments > 0 && <Count n={j.devComments} label={plural(j.devComments, "comment")} onClick={() => open(JETTA_WHO, "comments")} />,
      ]}
    />,
    <Parts
      key="other"
      parts={[
        j.handoffs.slack > 0 && <Count n={j.handoffs.slack} label={plural(j.handoffs.slack, "Slack escalation")} onClick={() => open(JETTA_WHO, "escalations")} />,
        j.handoffs.chat > 0 && <Count n={j.handoffs.chat} label={`${plural(j.handoffs.chat, "chat")} turned into a ticket`} onClick={() => open(JETTA_WHO, "ticketed")} />,
      ]}
    />,
  ];
}

const LINK = "underline decoration-dotted underline-offset-4 hover:decoration-solid";

function TodoRow({ label, why, children }: { label: string; why: string; children: React.ReactNode }) {
  return (
    <TableRow>
      <TableCell className="w-56 align-top">
        <div className="font-medium">{label}</div>
        <div className="whitespace-normal text-xs text-muted-foreground">{why}</div>
      </TableCell>
      <TableCell className="whitespace-normal align-top">
        <ul className="grid gap-1.5">{Array.isArray(children) ? children.map((c, i) => <li key={i}>{c}</li>) : <li>{children}</li>}</ul>
      </TableCell>
    </TableRow>
  );
}

function Waiting({ a, href }: { a: ReplyAction; href: string }) {
  return (
    <span className="flex flex-wrap items-baseline gap-x-2">
      <a href={href} target="_blank" rel="noreferrer" className={`${LINK} tabular-nums`}>
        #{a.id}
      </a>
      <span className="min-w-0 truncate">{a.subject}</span>
      <span className="text-xs text-muted-foreground">
        waiting {fmtHours(a.sinceH)}
        {a.lastBy ? ` · last answered by ${a.lastBy}` : ""}
        {a.draftReady ? " · draft ready" : ""}
      </span>
    </span>
  );
}

function DevUpdate({ a, ticketHref }: { a: DevAction; ticketHref?: string }) {
  return (
    <span className="flex flex-wrap items-baseline gap-x-2">
      {ticketHref && a.ticketId != null && (
        <a href={ticketHref} target="_blank" rel="noreferrer" className={`${LINK} tabular-nums`}>
          #{a.ticketId}
        </a>
      )}
      <a href={a.url} target="_blank" rel="noreferrer" className={`${LINK} min-w-0 truncate`}>
        {a.name}
      </a>
      <span className="text-xs text-muted-foreground">
        {a.app} · {fmtHours(a.sinceH)} ago
        {a.status ? ` · ${a.status}` : ""}
        {a.support.length ? ` · ${a.support.join(", ")}` : ""}
        {a.draftReady ? " · draft ready" : ""}
      </span>
    </span>
  );
}

function ListRow({ it, at, href }: { it: ListItem; at: string; href?: string }) {
  return (
    <li className="flex items-start gap-3 py-2 text-sm">
      <span className="w-12 shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums">{at}</span>
      <div className="min-w-0 flex-1">
        {href ? (
          <a href={href} target={href.startsWith("/") ? undefined : "_blank"} rel="noreferrer" className={`${LINK} break-words`}>
            {it.title}
          </a>
        ) : (
          <span className="break-words">{it.title}</span>
        )}
        {it.note && <div className="text-xs text-muted-foreground">{it.note}</div>}
      </div>
      {href && <ExternalLink className="mt-1 size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
    </li>
  );
}
