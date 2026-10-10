/**
 * Shown while a console page's server render is in flight. The shape matches
 * what nearly every page opens with — a PageHeader and a stack of cards — so
 * the content arrives into place instead of pushing the layout around.
 */
import { Skeleton } from "@/components/ui/skeleton";

export default function ConsoleLoading() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label="Loading">
      <div className="space-y-2">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <Skeleton className="h-36 w-full rounded-lg" />
      <Skeleton className="h-56 w-full rounded-lg" />
    </div>
  );
}
