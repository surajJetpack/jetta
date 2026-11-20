import { redirect } from "next/navigation";
import { gate } from "@/lib/console-auth";
import { PageHeader } from "@/components/jetta/page-header";
import ActivityPanel from "./activity-panel";

export const dynamic = "force-dynamic";

/**
 * What each person on the team did, and where — Freshdesk, chats, Slack,
 * monday and the console, in one scorecard and one timeline.
 *
 * Admin only, like /performance: every row names a person. The API route is
 * the real boundary (requireAdmin); the nav merely hides the link.
 */
export default async function ActivityPage({
  searchParams,
}: {
  /** A link from the daily team report: one person's actions of one kind on one day. */
  searchParams: Promise<{ person?: string; action?: string; column?: string; day?: string; tz?: string }>;
}) {
  const initial = await searchParams;
  const { locked } = await gate();
  // Keep the link's filters through sign-in: a report link is usually opened signed out.
  const qs = new URLSearchParams(Object.entries(initial).filter((e): e is [string, string] => typeof e[1] === "string")).toString();
  if (locked) redirect(`/login?next=${encodeURIComponent(qs ? `/activity?${qs}` : "/activity")}`);
  return (
    <>
      <PageHeader
        title="Team activity"
        description="Who did what across Freshdesk, chats, Slack, monday and the console."
      />
      <ActivityPanel initial={initial} />
    </>
  );
}
