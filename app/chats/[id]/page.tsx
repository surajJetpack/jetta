import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { gate } from "@/lib/console-auth";
import { Nav } from "../../nav";
import LiveReply from "./live-reply";
import { getConversation } from "@/lib/chat-store";
import { getRunLogsByTicket } from "@/lib/kv";
import { config } from "@/lib/config";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { RelativeTime } from "@/components/jetta/relative-time";

export const dynamic = "force-dynamic";

/**
 * One chat transcript plus the agent runs behind it — what Jetta retrieved,
 * which tools fired, and what it actually sent. This is the page a Slack
 * escalation deep-links to (see jettachat.conversationUrl), so it has to make
 * sense to someone arriving cold.
 */
export default async function ChatDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { locked, user } = await gate();
  if (locked) redirect(`/login?next=${encodeURIComponent(`/chats/${id}`)}`);

  const conv = await getConversation(id);
  if (!conv) notFound();

  const runs = await getRunLogsByTicket(id, 20);

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-5 pt-8 pb-20">
      <Nav current="chats" user={user} />

      <Link href="/chats" className="text-xs text-muted-foreground hover:underline">
        ← All chats
      </Link>

      <LiveReply conversationId={conv.id} status={conv.status} humanAgent={conv.humanAgent} />

      <Card className="gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={conv.status === "ticketed" ? "destructive" : "default"}>{conv.status}</Badge>
          <Badge variant="outline">{conv.surface}</Badge>
          {conv.visitor.app && <Badge variant="outline">{conv.visitor.app}</Badge>}
          <span className="ml-auto text-xs text-muted-foreground">
            started <RelativeTime at={Math.floor(Date.parse(conv.createdAt) / 1000)} />
          </span>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {conv.visitor.name && (
            <>
              <dt className="text-muted-foreground">Name</dt>
              <dd>{conv.visitor.name}</dd>
            </>
          )}
          {conv.visitor.email && (
            <>
              <dt className="text-muted-foreground">Email</dt>
              <dd>{conv.visitor.email}</dd>
            </>
          )}
          {conv.visitor.mondayAccountSlug && (
            <>
              <dt className="text-muted-foreground">monday account</dt>
              <dd>{conv.visitor.mondayAccountSlug}</dd>
            </>
          )}
          {conv.pageUrl && (
            <>
              <dt className="text-muted-foreground">Page</dt>
              <dd className="truncate">{conv.pageUrl}</dd>
            </>
          )}
          {conv.ticketId && (
            <>
              <dt className="text-muted-foreground">Ticket</dt>
              <dd>
                <a
                  className="underline"
                  href={`https://${config.freshdesk.domain ?? "jetpackapps.freshdesk.com"}/a/tickets/${conv.ticketId}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  #{conv.ticketId}
                </a>
              </dd>
            </>
          )}
        </dl>
      </Card>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Transcript</h2>
        {conv.messages.map((m) => (
          <div key={m.id} className={m.author === "visitor" ? "flex justify-start" : "flex justify-end"}>
            <div
              className={
                m.author === "visitor"
                  ? "max-w-[80%] rounded-lg rounded-bl-sm bg-muted px-3 py-2 text-sm whitespace-pre-wrap"
                  : m.via === "human"
                    ? "max-w-[80%] rounded-lg rounded-br-sm border border-primary/40 bg-primary/5 px-3 py-2 text-sm whitespace-pre-wrap"
                    : "max-w-[80%] rounded-lg rounded-br-sm bg-primary/10 px-3 py-2 text-sm whitespace-pre-wrap"
              }
            >
              <p className="mb-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                {/* Which of us said it. Reviewing Jetta's answers is impossible
                    if a colleague's reply is labelled with her name — and every
                    message predating handoff was hers, so undefined reads as Jetta. */}
                {m.author === "visitor"
                  ? "Customer"
                  : m.via === "human"
                    ? `${m.authorName ?? "Team"} (human)`
                    : "Jetta"}{" "}
                ·{" "}
                <RelativeTime at={Math.floor(Date.parse(m.createdAt) / 1000)} />
              </p>
              {m.text}
            </div>
          </div>
        ))}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Agent runs ({runs.length})</h2>
        {runs.length === 0 && (
          <p className="text-xs text-muted-foreground">No runs recorded for this conversation.</p>
        )}
        {runs.map((r) => (
          <Card key={r.id} className="gap-2 p-3 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <RelativeTime at={r.at} className="text-muted-foreground" />
              <Badge variant="outline">{r.model}</Badge>
              <span className="text-muted-foreground">{(r.durationMs / 1000).toFixed(1)}s</span>
              {r.replied && <Badge variant="secondary">replied</Badge>}
              {r.escalated && <Badge variant="destructive">escalated</Badge>}
              {r.error && <Badge variant="destructive">error</Badge>}
            </div>

            {r.kbHits.length > 0 && (
              <div>
                <p className="text-muted-foreground">Grounding</p>
                <ul className="list-inside list-disc">
                  {r.kbHits.map((h, i) => (
                    <li key={i}>
                      {h.title} <span className="text-muted-foreground">({h.source})</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div>
              <p className="text-muted-foreground">Tools</p>
              <ol className="list-inside list-decimal">
                {r.trace.map((t, i) => (
                  <li key={i}>
                    <span className="font-medium">{t.tool}</span>
                    <span className="text-muted-foreground"> — {t.result.slice(0, 160)}</span>
                  </li>
                ))}
              </ol>
            </div>

            {r.error && <p className="text-destructive">{r.error}</p>}
          </Card>
        ))}
      </section>
    </div>
  );
}
