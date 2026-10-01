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
export default async function ActivityPage() {
  const { locked } = await gate();
  if (locked) redirect("/login?next=%2Factivity");
  return (
    <>
      <PageHeader
        title="Team activity"
        description="Who did what across Freshdesk, chats, Slack, monday and the console."
      />
      <ActivityPanel />
    </>
  );
}
