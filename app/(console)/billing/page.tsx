import { redirect } from "next/navigation";
import { freshdeskDomain } from "@/lib/tools/freshdesk";
import { gate } from "@/lib/console-auth";
import { config } from "@/lib/config";
import { PageHeader } from "@/components/jetta/page-header";
import TrialsDiscountsQueue from "./billing-queue";

export const dynamic = "force-dynamic";

export default async function BillingPage() {
  const { locked } = await gate();
  if (locked) redirect("/login?next=%2Fbilling");
  // Open to the whole support team: the person reading the ticket that asked
  // for the trial is the person best placed to decide it, and every action on
  // this page now works for them (see app/api/admin/monetization/route.ts).
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
