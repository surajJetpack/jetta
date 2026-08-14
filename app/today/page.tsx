import { redirect } from "next/navigation";
import { gate } from "@/lib/console-auth";
import { Nav } from "../nav";
import TodayBrief from "./today-brief";

export const dynamic = "force-dynamic";

/**
 * The support team's morning read: what happened overnight, which issues are
 * spiking, and what's waiting on a human. Insights (/analytics) stays the ops
 * view — cost, tokens and model quality deliberately don't appear here.
 */
export default async function TodayPage() {
  const { locked, user, isAdmin } = await gate();
  if (locked) redirect("/login?next=%2Ftoday");
  return (
    <div className="mx-auto max-w-4xl space-y-5 px-5 pt-8 pb-20">
      <Nav current="today" user={user} isAdmin={isAdmin} />
      <TodayBrief />
    </div>
  );
}
