import { redirect } from "next/navigation";
import { gate } from "@/lib/console-auth";
import { config } from "@/lib/config";
import { Nav } from "../nav";
import TrialsDiscountsQueue from "./billing-queue";

export const dynamic = "force-dynamic";

export default async function BillingPage() {
  const { locked, user, isAdmin } = await gate();
  if (locked) redirect("/login?next=%2Fbilling");
  // Every action on this page is admin-only, so a general user landing here by
  // URL would see a list of approvals they cannot decide. Hiding the tab and
  // leaving the page reachable is a half-measure.
  if (!isAdmin) redirect("/today");
  return (
    <div className="mx-auto max-w-4xl space-y-5 px-5 pt-8 pb-20">
      <Nav current="billing" user={user} isAdmin={isAdmin} />
      <TrialsDiscountsQueue
        freshdeskDomain={config.freshdesk.domain ?? "jetpackapps.freshdesk.com"}
        writesEnabled={config.monday.monetization.allowWrites}
      />
    </div>
  );
}
