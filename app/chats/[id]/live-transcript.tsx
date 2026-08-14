"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, User, UserRound } from "lucide-react";
import { RelativeTime } from "@/components/jetta/relative-time";
import { StatusChip } from "@/components/jetta/status-chip";

interface Msg {
  id: string;
  author: "visitor" | "agent";
  via?: "jetta" | "human";
  authorName?: string;
  system?: boolean;
  text: string;
  createdAt: string;
}

/**
 * The transcript, kept current while someone has it open.
 *
 * This is what makes taking over a chat workable at all: the page was
 * server-rendered, so a colleague who joined a conversation could not see the
 * visitor's next message without reloading — they were replying blind to a
 * person sitting in front of a live widget.
 *
 * Polls rather than streams. The visitor's widget has SSE because it must feel
 * instant; three seconds is imperceptible to someone reading and typing, and
 * a poll survives a serverless boundary without holding a connection open.
 */
export default function LiveTranscript({
  conversationId,
  initial,
  intervalMs = 3000,
}: {
  conversationId: string;
  initial: Msg[];
  intervalMs?: number;
}) {
  const [messages, setMessages] = useState<Msg[]>(initial);
  const [live, setLive] = useState(true);
  const endRef = useRef<HTMLDivElement | null>(null);
  const countRef = useRef(initial.length);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/chats?id=${encodeURIComponent(conversationId)}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const { conversation } = (await res.json()) as { conversation: { messages: Msg[] } };
      setMessages(conversation.messages ?? []);
      setLive(true);
    } catch {
      // A dropped poll is not worth a banner; the next one usually succeeds.
      setLive(false);
    }
  }, [conversationId]);

  useEffect(() => {
    const t = setInterval(poll, intervalMs);
    return () => clearInterval(t);
  }, [poll, intervalMs]);

  // Only scroll when something new arrives, so reading back through a long
  // transcript isn't yanked to the bottom every few seconds.
  useEffect(() => {
    if (messages.length > countRef.current) endRef.current?.scrollIntoView({ behavior: "smooth" });
    countRef.current = messages.length;
  }, [messages.length]);

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Transcript</h2>
        <span className="text-[11px] text-muted-foreground">
          {live ? "updating live" : "reconnecting…"} · {messages.length} messages
        </span>
      </div>

      {messages.map((m) => {
        if (m.system) {
          return (
            <p key={m.id} className="py-1 text-center text-[11px] text-muted-foreground">
              {m.text}
            </p>
          );
        }
        const human = m.via === "human";
        const who = m.author === "visitor" ? "Customer" : human ? `${m.authorName ?? "Team"}` : "Jetta";
        const Icon = m.author === "visitor" ? User : human ? UserRound : Bot;
        return (
          <div key={m.id} className={m.author === "visitor" ? "flex justify-start" : "flex justify-end"}>
            <div
              className={
                m.author === "visitor"
                  ? "max-w-[80%] rounded-lg rounded-bl-sm bg-muted px-3 py-2 text-sm whitespace-pre-wrap"
                  : human
                    ? "max-w-[80%] rounded-lg rounded-br-sm border border-primary/40 bg-primary/5 px-3 py-2 text-sm whitespace-pre-wrap"
                    : "max-w-[80%] rounded-lg rounded-br-sm bg-primary/10 px-3 py-2 text-sm whitespace-pre-wrap"
              }
            >
              <p className="mb-0.5 flex items-center gap-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                <Icon className="size-3" aria-hidden />
                {who}
                {human && <StatusChip tone="in_review">human</StatusChip>}
                · <RelativeTime at={Math.floor(Date.parse(m.createdAt) / 1000)} />
              </p>
              {m.text}
            </div>
          </div>
        );
      })}
      <div ref={endRef} />
    </section>
  );
}
