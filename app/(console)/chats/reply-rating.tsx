"use client";

/**
 * 👍 / 👎 under one of Jetta's chat replies, for the team reading the
 * transcript. A click saves at once; 👎 then offers reasons and a note, which
 * update the same rating. Clicking your thumb again takes it back. Colleagues'
 * ratings show as names beside the thumbs, so two people don't file the same
 * complaint and a disagreement is visible.
 */
import { useCallback, useEffect, useState } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { CHAT_FEEDBACK_REASONS, type ChatFeedbackReason } from "@/lib/chat-feedback-reasons";

export interface ReplyRatingRow {
  messageId: string;
  author: string;
  mine: boolean;
  rating: "up" | "down";
  reasons: ChatFeedbackReason[];
  note?: string;
}

/** Every rating on one conversation, refetched when the conversation changes. */
export function useChatRatings(conversationId: string) {
  // Keyed by conversation, so switching chats never shows the last one's ratings while the next load runs.
  const [state, setState] = useState<{ id: string; rows: ReplyRatingRow[] }>({ id: "", rows: [] });
  const fetchRows = useCallback(
    () =>
      fetch(`/api/admin/chat-feedback?conversation=${encodeURIComponent(conversationId)}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((b: { ratings?: ReplyRatingRow[] } | null) => (b ? (b.ratings ?? []) : null))
        .catch(() => null),
    [conversationId],
  );
  useEffect(() => {
    let live = true;
    void fetchRows().then((rows) => live && rows && setState({ id: conversationId, rows }));
    return () => {
      live = false;
    };
  }, [conversationId, fetchRows]);
  const reload = useCallback(async () => {
    const rows = await fetchRows();
    if (rows) setState({ id: conversationId, rows });
  }, [conversationId, fetchRows]);
  return { rows: state.id === conversationId ? state.rows : [], reload };
}

const ICON_BTN =
  "flex size-6 items-center justify-center rounded-md transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none";

export function ReplyRating({
  conversationId,
  messageId,
  rows,
  reload,
}: {
  conversationId: string;
  messageId: string;
  /** Ratings on this message only. */
  rows: ReplyRatingRow[];
  reload: () => Promise<void>;
}) {
  const mine = rows.find((r) => r.mine);
  const others = rows.filter((r) => !r.mine);
  const [details, setDetails] = useState(false);
  const [reasons, setReasons] = useState<ChatFeedbackReason[]>(mine?.reasons ?? []);
  const [note, setNote] = useState(mine?.note ?? "");
  const [busy, setBusy] = useState(false);

  async function call(method: "POST" | "DELETE", body: Record<string, unknown>) {
    setBusy(true);
    const r = await fetch("/api/admin/chat-feedback", {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId, messageId, ...body }),
    }).catch(() => null);
    setBusy(false);
    if (!r?.ok) {
      toast.error("Couldn't save that rating. Try again in a moment.");
      return false;
    }
    await reload();
    return true;
  }

  async function choose(next: "up" | "down") {
    if (mine?.rating === next) {
      setDetails(false);
      await call("DELETE", {});
      return;
    }
    if (next === "up") {
      setReasons([]);
      setNote("");
    }
    if (await call("POST", { rating: next })) setDetails(next === "down");
  }

  async function sendDetails(e: React.FormEvent) {
    e.preventDefault();
    if (await call("POST", { rating: "down", reasons, note })) {
      setDetails(false);
      toast.success("Saved to Feedback.");
    }
  }

  return (
    <div className="flex flex-col items-end gap-1.5 pe-[38px]">
      <div className="flex items-center gap-1 text-muted-foreground">
        {others.length > 0 && (
          <span className="me-1 text-3xs">{others.map((o) => `${o.rating === "up" ? "👍" : "👎"} ${o.author}`).join(" · ")}</span>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => void choose("up")}
          aria-label="Good reply"
          aria-pressed={mine?.rating === "up"}
          title="Good reply"
          className={cn(
            ICON_BTN,
            mine?.rating === "up" ? "text-tone-good" : "opacity-60 hover:bg-accent hover:text-foreground hover:opacity-100",
          )}
        >
          <ThumbsUp className={cn("size-3.5", mine?.rating === "up" && "fill-current")} />
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void choose("down")}
          aria-label="Bad reply"
          aria-pressed={mine?.rating === "down"}
          title="Bad reply"
          className={cn(
            ICON_BTN,
            mine?.rating === "down" ? "text-tone-bad" : "opacity-60 hover:bg-accent hover:text-foreground hover:opacity-100",
          )}
        >
          <ThumbsDown className={cn("size-3.5", mine?.rating === "down" && "fill-current")} />
        </button>
        {mine?.rating === "down" && !details && (
          <button type="button" onClick={() => setDetails(true)} className="ms-1 text-3xs underline-offset-2 hover:underline">
            {mine.reasons.length || mine.note ? "Edit why" : "Add why"}
          </button>
        )}
      </div>
      {details && (
        <form onSubmit={sendDetails} className="w-full max-w-[72%] space-y-2 rounded-md border bg-card p-2.5">
          <p className="text-xs text-muted-foreground">What was wrong? (optional)</p>
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(CHAT_FEEDBACK_REASONS) as ChatFeedbackReason[]).map((r) => {
              const on = reasons.includes(r);
              return (
                <button
                  key={r}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setReasons(on ? reasons.filter((x) => x !== r) : [...reasons, r])}
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 text-xs transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                    on ? "border-tone-bad/50 bg-tone-bad-bg text-tone-bad" : "bg-background hover:bg-accent",
                  )}
                >
                  {CHAT_FEEDBACK_REASONS[r]}
                </button>
              );
            })}
          </div>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="What should she have said?"
            aria-label="Feedback note"
            className="w-full resize-none rounded-md border border-input bg-background px-2.5 py-1.5 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setDetails(false)}
              className="rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              Skip
            </button>
            <button
              type="submit"
              disabled={busy || (!reasons.length && !note.trim())}
              className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              Send
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
