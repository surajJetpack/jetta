"use client";

/**
 * The console's error boundary. It renders inside the shell, so a page that
 * throws keeps its sidebar and topbar — the reader can still navigate away —
 * rather than collapsing to Next's bare default screen.
 *
 * The error message itself is not shown: in production it is redacted to a
 * generic string anyway, and a stack trace is not something a support agent
 * can act on. The digest is, because it is what finds the server log line.
 */
import { useEffect } from "react";
import { RotateCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/jetta/empty-state";

export default function ConsoleError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <EmptyState
      icon={TriangleAlert}
      title="This page couldn't load"
      hint={
        error.digest
          ? `Something failed on our side. Try again, and if it keeps happening, share reference ${error.digest}.`
          : "Something failed while loading this page. Try again in a moment."
      }
      className="py-16"
      action={
        <Button size="sm" variant="outline" className="mt-2" onClick={() => unstable_retry()}>
          <RotateCw /> Try again
        </Button>
      }
    />
  );
}
