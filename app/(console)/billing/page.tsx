import { redirect } from "next/navigation";
import { freshdeskDomain } from "@/lib/tools/freshdesk";
import { gate } from "@/lib/console-auth";
import { config } from "@/lib/config";
import { PageHeader } from "@/components/jetta/page-header";
import TrialsDiscountsQueue from "./billing-queue";

export const dynamic = "force-dynamic";

export default async function BillingPage() {
  const { locked, isAdmin } = await gate();
  if (locked) redirect("/login?next=%2Fbilling");
  // Every action on this page is admin-only, so a general user landing here by
  // URL would see a list of approvals they cannot decide. Hiding the tab and
  // leaving the page reachable is a half-measure.
  if (!isAdmin) redirect("/today");
  return (
    <>
      <PageHeader
        title="Billing"
        description="Trial extensions and discounts Jetta filed for a person to decide."
      />
      <TrialsDiscountsQueue
        freshdeskDomain={freshdeskDomain()}
        writesEnabled={config.monday.monetization.allowWrites}
      />
    </>
  );
}
