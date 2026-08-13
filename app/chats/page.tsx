import { redirect } from "next/navigation";
import Link from "next/link";
import { gate } from "@/lib/console-auth";
import { Nav } from "../nav";
import { listConversations } from "@/lib/chat-store";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { RelativeTime } from "@/components/jetta/relative-time";
import { EmptyState } from "@/components/jetta/empty-state";

export const dynamic = "force-dynamic";

/**
 * JettaChat review surface.
 *
 * This is the compensating control for the one safety property chat gives up:
 * on Freshdesk a human reads every reply before the customer does, and here
 * nobody does. Review moves after the fact, so the transcripts have to be
 * genuinely easy to skim — that is the whole job of this page.
 */
export default async function ChatsPage() {
  const { locked, user } = await gate();
  if (locked) redirect("/login?next=%2Fchats");

  const conversations = await listConversations(100);

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-5 pt-8 pb-20">
      <Nav current="chats" user={user} />

      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Chat conversations</h2>
        <p className="text-xs text-muted-foreground">
          Autonomous — these replies were sent without review.
        </p>
      </div>

      {conversations.length === 0 ? (
        <EmptyState title="No chats yet" hint="Conversations from the site widget appear here." />
      ) : (
        <div className="space-y-2">
          {conversations.map((c) => {
            const lastVisitor = [...c.messages].reverse().find((m) => m.author === "visitor");
            return (
              <Link key={c.id} href={`/chats/${c.id}`} className="block">
                <Card className="gap-2 p-4 transition-colors hover:bg-muted/50">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={
                        c.status === "ticketed" ? "destructive"
                        : c.status === "resolved" ? "secondary"
                        : "default"
                      }
                    >
                      {c.status}
                    </Badge>
                    <Badge variant="outline">{c.surface}</Badge>
                    {c.visitor.mondayAccountSlug && (
                      <Badge variant="outline">{c.visitor.mondayAccountSlug}</Badge>
                    )}
                    <span className="ml-auto text-xs text-muted-foreground">
                      <RelativeTime at={Math.floor(Date.parse(c.lastActivityAt) / 1000)} />
                    </span>
                  </div>
                  <p className="line-clamp-2 text-sm">
                    {lastVisitor?.text ?? <span className="text-muted-foreground">(no messages)</span>}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {c.messages.length} message{c.messages.length === 1 ? "" : "s"}
                    {c.visitor.email ? ` · ${c.visitor.email}` : ""}
                    {c.ticketId ? ` · ticket #${c.ticketId}` : ""}
                  </p>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
