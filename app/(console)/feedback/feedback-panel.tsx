"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { MessageSquareQuote } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/jetta/empty-state";
import { RelativeTime } from "@/components/jetta/relative-time";
import { usePolling } from "@/lib/use-polling";
import type { FeedbackEntry } from "@/lib/feedback";

export default function FeedbackPanel({ canEdit }: { canEdit: boolean }) {
  const [rows, setRows] = useState<FeedbackEntry[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/feedback", { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      setRows((await r.json()).feedback ?? []);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  usePolling(load, 60_000);

  async function setDone(id: string, done: boolean) {
    const r = await fetch("/api/admin/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, done }),
    });
    if (!r.ok) {
      toast.error("Couldn't save that. Try again in a moment.");
      return;
    }
    await load();
  }

  if (failed) return <EmptyState title="The feedback list couldn't be loaded" hint="Try again in a moment." />;
  if (!rows) return <Skeleton className="h-40 w-full" />;
  if (!rows.length) {
    return (
      <EmptyState
        icon={MessageSquareQuote}
        title="No feedback yet"
        hint='On any item on the monday dev boards, write a comment that starts with "Jetta feedback:". Jetta saves it here and thanks the writer in the thread.'
      />
    );
  }

  const open = rows.filter((r) => !r.doneAt).length;
  return (
    <div className="grid gap-3">
      <p className="text-muted-foreground text-sm">
        {open} open, {rows.length - open} handled.
      </p>
      {rows.map((f) => (
        <Card key={f.id} className={f.doneAt ? "py-4 opacity-60" : "py-4"}>
          <CardContent className="grid gap-2 px-4">
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <span className="text-foreground font-medium">{f.author}</span>
              <RelativeTime at={Math.floor(Date.parse(f.at) / 1000)} />
              {f.itemUrl ? (
                <a href={f.itemUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                  {f.itemName ?? "Dev item"}
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
    </div>
  );
}
