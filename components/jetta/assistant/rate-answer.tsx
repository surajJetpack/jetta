"use client";

import { useState } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { ASSISTANT_FEEDBACK_REASONS, type AssistantFeedbackReason } from "@/lib/assistant-feedback-reasons";
import type { AnswerSnapshot } from "./rating-snapshot";

export type Rating = "up" | "down";

const ICON_BTN =
  "flex size-6 items-center justify-center rounded-md transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none";

/**
 * 👍 / 👎 under one of Jetta's answers. A click saves at once; 👎 then offers
 * reasons and a note, which update the same entry. Clicking the chosen thumb
 * again takes the rating back.
 */
export function RateAnswer({
  id,
  snapshot,
  path,
  via,
}: {
  id: string;
  snapshot: AnswerSnapshot;
  path: string;
  via: "text" | "voice";
}) {
  const [rating, setRating] = useState<Rating | null>(null);
  const [details, setDetails] = useState(false);
  const [reasons, setReasons] = useState<AssistantFeedbackReason[]>([]);
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");

  async function save(next: Rating, extra?: { reasons: AssistantFeedbackReason[]; note: string }) {
    setStatus("saving");
    const r = await fetch("/api/admin/assistant/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, rating: next, ...snapshot, path, via, reasons: extra?.reasons ?? [], note: extra?.note ?? "" }),
    }).catch(() => null);
    setStatus(r?.ok ? "saved" : "failed");
    return !!r?.ok;
  }

  async function choose(next: Rating) {
    if (rating === next) {
      setRating(null);
      setDetails(false);
      setStatus("idle");
      await fetch("/api/admin/assistant/feedback", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      }).catch(() => null);
      return;
    }
    setRating(next);
    setDetails(next === "down");
    if (next === "up") {
      setReasons([]);
      setNote("");
    }
    await save(next);
  }

  async function sendDetails(e: React.FormEvent) {
    e.preventDefault();
    if (await save("down", { reasons, note })) setDetails(false);
  }

  return (
    <div className="mt-1 space-y-2">
      <div className="flex items-center gap-1 text-muted-foreground">
        <button
          type="button"
          onClick={() => void choose("up")}
          aria-label="Good answer"
          aria-pressed={rating === "up"}
          className={cn(ICON_BTN, rating === "up" ? "text-tone-good" : "hover:bg-accent hover:text-foreground")}
        >
          <ThumbsUp className={cn("size-3.5", rating === "up" && "fill-current")} />
        </button>
        <button
          type="button"
          onClick={() => void choose("down")}
          aria-label="Bad answer"
          aria-pressed={rating === "down"}
          className={cn(ICON_BTN, rating === "down" ? "text-tone-bad" : "hover:bg-accent hover:text-foreground")}
        >
          <ThumbsDown className={cn("size-3.5", rating === "down" && "fill-current")} />
        </button>
        {status === "saved" && !details && <span className="ml-1 text-[11px]">Thanks, saved to Feedback</span>}
        {status === "failed" && <span className="ml-1 text-[11px] text-tone-bad">Couldn&apos;t save. Try again.</span>}
      </div>
      {details && (
        <form onSubmit={sendDetails} className="space-y-2 rounded-md border bg-card p-2.5">
          <p className="text-xs text-muted-foreground">What was wrong? (optional)</p>
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(ASSISTANT_FEEDBACK_REASONS) as AssistantFeedbackReason[]).map((r) => {
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
                  {ASSISTANT_FEEDBACK_REASONS[r]}
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
              disabled={status === "saving" || (!reasons.length && !note.trim())}
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
