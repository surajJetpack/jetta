"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { MessageSquareQuote, ThumbsDown, ThumbsUp } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/jetta/empty-state";
import { RelativeTime } from "@/components/jetta/relative-time";
import { usePolling } from "@/lib/use-polling";
import type { FeedbackEntry } from "@/lib/feedback";
import type { AssistantFeedback } from "@/lib/assistant-feedback";
import { ASSISTANT_FEEDBACK_REASONS } from "@/lib/assistant-feedback-reasons";
import type { ChatFeedback } from "@/lib/chat-feedback";
import { CHAT_FEEDBACK_REASONS } from "@/lib/chat-feedback-reasons";
import { appName } from "@/lib/types";

export default function FeedbackPanel({ canEdit }: { canEdit: boolean }) {
  const [rows, setRows] = useState<FeedbackEntry[] | null>(null);
  const [ratings, setRatings] = useState<AssistantFeedback[]>([]);
  const [chatRatings, setChatRatings] = useState<ChatFeedback[]>([]);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/feedback", { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      const body = await r.json();
      setRows(body.feedback ?? []);
      setRatings(body.assistant ?? []);
      setChatRatings(body.chat ?? []);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  usePolling(load, 60_000);

  async function setDone(id: string, done: boolean, kind?: "chat" | "assistant") {
    const r = await fetch("/api/admin/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, done, kind }),
    });
    if (!r.ok) {
      toast.error("Couldn't save that. Try again in a moment.");
      return;
    }
    await load();
  }

  if (failed) return <EmptyState title="The feedback list couldn't be loaded" hint="Try again in a moment." />;
  if (!rows) return <Skeleton className="h-40 w-full" />;
  const assistant = (
    <>
      <ChatRatings rows={chatRatings} canEdit={canEdit} setDone={setDone} />
      <AssistantRatings rows={ratings} canEdit={canEdit} setDone={setDone} />
    </>
  );
  if (!rows.length) {
    return (
      <div className="grid gap-6">
        {assistant}
        <EmptyState
          icon={MessageSquareQuote}
          title="No feedback yet"
          hint='Start a comment on a monday dev item, or a private note on a Freshdesk ticket, with "Jetta feedback:". Jetta saves it here (on monday she also thanks the writer in the thread).'
        />
      </div>
    );
  }

  const open = rows.filter((r) => !r.doneAt).length;
  return (
    <div className="grid gap-6">
      {assistant}
      <section className="grid gap-3">
        <h2 className="text-sm font-medium">&quot;Jetta feedback:&quot; on the dev boards and in Freshdesk notes</h2>
        <p className="text-muted-foreground text-sm">
          {open} open, {rows.length - open} handled.
        </p>
        {rows.map((f) => (
          <Card key={f.id} className={f.doneAt ? "py-4 opacity-60" : "py-4"}>
            <CardContent className="grid gap-2 px-4">
              <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <span className="text-foreground font-medium">{f.author}</span>
                <RelativeTime at={Math.floor(Date.parse(f.at) / 1000)} />
                <span>{f.source === "freshdesk" ? "Freshdesk note" : "Dev board"}</span>
                {f.itemUrl ? (
                  <a href={f.itemUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                    {f.itemName ?? (f.source === "freshdesk" ? `Ticket #${f.itemId}` : "Dev item")}
                  </a>
                ) : (
                  <span>{f.itemName ?? `Item ${f.itemId}`}</span>
                )}
                {f.doneAt && <span>Handled by {f.doneBy}</span>}
              </div>
              <p className="text-sm whitespace-pre-wrap">{f.text}</p>
              {canEdit && (
                <div>
                  <Button size="sm" variant="outline" onClick={() => void setDone(f.id, !f.doneAt)}>
                    {f.doneAt ? "Open again" : "Mark handled"}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </section>
    </div>
  );
}

/**
 * Ratings from the ⌘J panel. A 👎 is a card with the whole exchange, because
 * nothing else keeps it; a 👍 is one line, since there is nothing to fix.
 */
function AssistantRatings({
  rows,
  canEdit,
  setDone,
}: {
  rows: AssistantFeedback[];
  canEdit: boolean;
  setDone: (id: string, done: boolean, kind?: "chat" | "assistant") => Promise<void>;
}) {
  const down = rows.filter((r) => r.rating === "down");
  const up = rows.filter((r) => r.rating === "up");
  const open = down.filter((r) => !r.doneAt).length;
  return (
    <section className="grid gap-3">
      <h2 className="text-sm font-medium">Console assistant answers</h2>
      <p className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="inline-flex items-center gap-1">
          <ThumbsUp className="text-tone-good size-3.5" aria-hidden /> {up.length} good
        </span>
        <span className="inline-flex items-center gap-1">
          <ThumbsDown className="text-tone-bad size-3.5" aria-hidden /> {down.length} bad, {open} open
        </span>
      </p>
      {!rows.length && (
        <p className="text-muted-foreground text-sm">No ratings yet. Under each answer in the ⌘J panel there is a 👍 and a 👎.</p>
      )}
      {down.map((f) => (
        <Card key={f.id} className={f.doneAt ? "py-4 opacity-60" : "py-4"}>
          <CardContent className="grid gap-2 px-4">
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <ThumbsDown className="text-tone-bad size-3.5" aria-label="Rated bad" />
              <span className="text-foreground font-medium">{f.author}</span>
              <RelativeTime at={Math.floor(Date.parse(f.at) / 1000)} />
              {f.path && <span>on {f.path}</span>}
              {f.via && <span>{f.via === "voice" ? "spoken" : "typed"}</span>}
              {f.doneAt && <span>Handled by {f.doneBy}</span>}
            </div>
            {(f.reasons.length > 0 || f.note) && (
              <div className="grid gap-1">
                {f.reasons.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {f.reasons.map((r) => (
                      <span key={r} className="bg-tone-bad-bg text-tone-bad rounded-full px-2 py-0.5 text-xs">
                        {ASSISTANT_FEEDBACK_REASONS[r] ?? r}
                      </span>
                    ))}
                  </div>
                )}
                {f.note && <p className="text-sm whitespace-pre-wrap">{f.note}</p>}
              </div>
            )}
            <div className="bg-muted/50 grid gap-1.5 rounded-md p-3 text-sm">
              <p>
                <span className="text-muted-foreground text-xs">Asked: </span>
                {f.question || <span className="text-muted-foreground">(she spoke first)</span>}
              </p>
              {f.steps.length > 0 && <p className="text-muted-foreground text-xs">Looked up: {f.steps.join(" · ")}</p>}
              <p className="whitespace-pre-wrap">
                <span className="text-muted-foreground text-xs">Jetta: </span>
                {f.answer}
              </p>
            </div>
            {canEdit && (
              <div>
                <Button size="sm" variant="outline" onClick={() => void setDone(f.id, !f.doneAt, "assistant")}>
                  {f.doneAt ? "Open again" : "Mark handled"}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
      {up.length > 0 && (
        <details className="text-sm">
          <summary className="text-muted-foreground cursor-pointer text-xs">Answers rated good ({up.length})</summary>
          <ul className="mt-2 grid gap-1.5">
            {up.map((f) => (
              <li key={f.id} className="text-muted-foreground flex flex-wrap items-baseline gap-x-2 text-xs">
                <ThumbsUp className="text-tone-good size-3 shrink-0 self-center" aria-hidden />
                <span className="text-foreground">{f.question || f.answer.slice(0, 120)}</span>
                <span>
                  {f.author}, <RelativeTime at={Math.floor(Date.parse(f.at) / 1000)} />
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/**
 * Ratings of Jetta's chat replies, given on the Chats page. Her chat replies
 * reach the customer unreviewed, so a 👎 here is the review catching one.
 */
function ChatRatings({
  rows,
  canEdit,
  setDone,
}: {
  rows: ChatFeedback[];
  canEdit: boolean;
  setDone: (id: string, done: boolean, kind?: "chat" | "assistant") => Promise<void>;
}) {
  const down = rows.filter((r) => r.rating === "down");
  const up = rows.filter((r) => r.rating === "up");
  const open = down.filter((r) => !r.doneAt).length;
  return (
    <section className="grid gap-3">
      <h2 className="text-sm font-medium">Jetta&apos;s chat replies</h2>
      <p className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="inline-flex items-center gap-1">
          <ThumbsUp className="text-tone-good size-3.5" aria-hidden /> {up.length} good
        </span>
        <span className="inline-flex items-center gap-1">
          <ThumbsDown className="text-tone-bad size-3.5" aria-hidden /> {down.length} bad, {open} open
        </span>
      </p>
      {!rows.length && (
        <p className="text-muted-foreground text-sm">No ratings yet. Under each of Jetta&apos;s replies on the Chats page there is a 👍 and a 👎.</p>
      )}
      {down.map((f) => (
        <Card key={f.id} className={f.doneAt ? "py-4 opacity-60" : "py-4"}>
          <CardContent className="grid gap-2 px-4">
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <ThumbsDown className="text-tone-bad size-3.5" aria-label="Rated bad" />
              <span className="text-foreground font-medium">{f.author}</span>
              <RelativeTime at={Math.floor(Date.parse(f.at) / 1000)} />
              <a href={`/chats?c=${encodeURIComponent(f.conversationId)}`} className="underline underline-offset-2">
                Chat with {f.visitorName || "a visitor"}
              </a>
              {f.app && f.app !== "unknown" && <span>{appName(f.app)}</span>}
              {f.doneAt && <span>Handled by {f.doneBy}</span>}
            </div>
            {(f.reasons.length > 0 || f.note) && (
              <div className="grid gap-1">
                {f.reasons.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {f.reasons.map((r) => (
                      <span key={r} className="bg-tone-bad-bg text-tone-bad rounded-full px-2 py-0.5 text-xs">
                        {CHAT_FEEDBACK_REASONS[r] ?? r}
                      </span>
                    ))}
                  </div>
                )}
                {f.note && <p className="text-sm whitespace-pre-wrap">{f.note}</p>}
              </div>
            )}
            <div className="bg-muted/50 grid gap-1.5 rounded-md p-3 text-sm">
              <p className="whitespace-pre-wrap">
                <span className="text-muted-foreground text-xs">Customer: </span>
                {f.customer || <span className="text-muted-foreground">(Jetta wrote first)</span>}
              </p>
              <p className="whitespace-pre-wrap">
                <span className="text-muted-foreground text-xs">Jetta: </span>
                {f.reply}
              </p>
            </div>
            {canEdit && (
              <div>
                <Button size="sm" variant="outline" onClick={() => void setDone(f.id, !f.doneAt, "chat")}>
                  {f.doneAt ? "Open again" : "Mark handled"}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
      {up.length > 0 && (
        <details className="text-sm">
          <summary className="text-muted-foreground cursor-pointer text-xs">Replies rated good ({up.length})</summary>
          <ul className="mt-2 grid gap-1.5">
            {up.map((f) => (
              <li key={f.id} className="text-muted-foreground flex flex-wrap items-baseline gap-x-2 text-xs">
                <ThumbsUp className="text-tone-good size-3 shrink-0 self-center" aria-hidden />
                <a href={`/chats?c=${encodeURIComponent(f.conversationId)}`} className="text-foreground hover:underline">
                  {f.reply.slice(0, 120)}
                  {f.reply.length > 120 ? "…" : ""}
                </a>
                <span>
                  {f.author}, <RelativeTime at={Math.floor(Date.parse(f.at) / 1000)} />
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
