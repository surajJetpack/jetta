import { redirect } from "next/navigation";
import { gate } from "@/lib/console-auth";
import { PageHeader } from "@/components/jetta/page-header";
import PerformancePanel from "./performance-panel";

export const dynamic = "force-dynamic";

/**
 * What customers actually got, and how much of it was Jetta's.
 *
 * Insights reads Jetta's own records; this page reads Freshdesk, because in
 * draft mode a human sends every reply and only Freshdesk knows what went out.
 * Admin only — the per-agent table is a coaching tool, not a leaderboard.
 */
export default async function PerformancePage() {
  const { locked } = await gate();
  if (locked) redirect("/login?next=%2Fperformance");
  return (
    <>
      <PageHeader
        title="Performance"
        description="Reply times, answer quality, and how often Jetta's suggestion is what the customer received."
      />
      <PerformancePanel />
    </>
  );
}
