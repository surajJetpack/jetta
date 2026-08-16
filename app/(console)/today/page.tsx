import { redirect } from "next/navigation";
import { gate } from "@/lib/console-auth";
import { PageHeader } from "@/components/jetta/page-header";
import TodayBrief from "./today-brief";

export const dynamic = "force-dynamic";

/**
 * The support team's morning read: what happened overnight, which issues are
 * spiking, and what's waiting on a human. Insights (/analytics) stays the ops
 * view — cost, tokens and model quality deliberately don't appear here.
 */
export default async function TodayPage() {
  const { locked, isAdmin } = await gate();
  if (locked) redirect("/login?next=%2Ftoday");
  return (
    <>
      <PageHeader
        title="Today"
        description="What came in overnight, what's spiking, and what needs a person."
      />
      <TodayBrief isAdmin={isAdmin} />
    </>
  );
}
