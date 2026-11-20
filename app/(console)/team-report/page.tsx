import { redirect } from "next/navigation";
import { gate } from "@/lib/console-auth";
import { PageHeader } from "@/components/jetta/page-header";
import TeamReportPanel from "./team-report-panel";

export const dynamic = "force-dynamic";

/**
 * The daily team report, in the console: the same numbers Jetta posts to Slack
 * each morning, with the list behind every count. A count in the Slack post
 * links here (?day=&who=&list=) and the page opens on that list.
 *
 * Admin only, like /activity: every row names a person. The API route is the
 * real boundary (requireAdmin); the nav merely hides the link.
 */
export default async function TeamReportPage({
  searchParams,
}: {
  searchParams: Promise<{ day?: string; who?: string; list?: string }>;
}) {
  const initial = await searchParams;
  const { locked } = await gate();
  // Keep the link's target through sign-in: a link from Slack is usually opened signed out.
  const qs = new URLSearchParams(Object.entries(initial).filter((e): e is [string, string] => typeof e[1] === "string")).toString();
  if (locked) redirect(`/login?next=${encodeURIComponent(qs ? `/team-report?${qs}` : "/team-report")}`);
  return (
    <>
      <PageHeader title="Daily report" description="What the team did on one day, what needs doing, and the list behind every count." />
      <TeamReportPanel initial={initial} />
    </>
  );
}
