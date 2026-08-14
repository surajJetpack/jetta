"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Hand, Send, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { StatusChip } from "@/components/jetta/status-chip";

/**
 * Taking over a live chat.
 *
 * The visitor needs nothing new to receive these: their widget already polls
 * the conversation store, so a message sent here arrives exactly as one of
 * Jetta's does. What joining really does is silence her — two voices answering
 * one person is what makes a handoff feel broken.
 */
export default function LiveReply({
  conversationId,
  status,
  humanAgent,
}: {
  conversationId: string;
  status: string;
  humanAgent?: string;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const call = useCallback(
    async (action: "join" | "send" | "release", body?: string) => {
      setBusy(true);
      try {
        const res = await fetch("/api/admin/chats", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId, action, text: body }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
        if (action === "send") setText("");
        router.refresh();
        return true;
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [conversationId, router],
  );

  const mine = status === "human";
  const waiting = status === "waiting_human";

  return (
    <Card className={waiting ? "border-primary/50" : undefined}>
      <CardContent className="space-y-3 pt-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {waiting && <StatusChip tone="stale">visitor is waiting for a person</StatusChip>}
          {mine && <StatusChip tone="in_review">you have this chat{humanAgent ? ` · ${humanAgent}` : ""}</StatusChip>}
          {!mine && !waiting && <StatusChip tone="published">Jetta is handling it</StatusChip>}
          <span className="text-xs text-muted-foreground">
            {mine
              ? "Jetta is silent until you hand it back."
              : "Sending a message takes the conversation and silences Jetta."}
          </span>
        </div>

        <Textarea
          rows={3}
          value={text}
          placeholder="Reply to the visitor…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter breaks the line — chat convention, and
            // the reason this is a client component at all.
            if (e.key === "Enter" && !e.shiftKey && text.trim() && !busy) {
              e.preventDefault();
              void call("send", text.trim());
            }
          }}
          disabled={busy}
        />

        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy || !text.trim()} onClick={() => void call("send", text.trim())}>
            <Send /> Send as yourself
          </Button>
          {!mine && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void call("join")}>
              <Hand /> Take the chat
            </Button>
          )}
          {mine && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void call("release")}>
              <Undo2 /> Hand back to Jetta
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
