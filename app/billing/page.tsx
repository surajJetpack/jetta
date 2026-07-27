import { redirect } from "next/navigation";
import { gate } from "@/lib/console-auth";
import { config } from "@/lib/config";
import { Nav } from "../nav";
import TrialsDiscountsQueue from "./billing-queue";

export const dynamic = "force-dynamic";

export default async function BillingPage() {
  const { locked, user } = await gate();
  if (locked) redirect("/login?next=%2Fbilling");
  return (
    <div className="mx-auto max-w-4xl space-y-5 px-5 pt-8 pb-20">
      <Nav current="billing" user={user} />
      <TrialsDiscountsQueue
        freshdeskDomain={config.freshdesk.domain ?? "jetpackapps.freshdesk.com"}
        writesEnabled={config.monday.monetization.allowWrites}
      />
    </div>
  );
}
