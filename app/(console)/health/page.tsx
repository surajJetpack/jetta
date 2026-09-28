import { redirect } from "next/navigation";
import { gate } from "@/lib/console-auth";
import { PageHeader } from "@/components/jetta/page-header";
import HealthPanel from "./health-panel";

export const dynamic = "force-dynamic";

/**
 * Is support in good shape? Written for the person the team reports to:
 * demand, speed, whether answers stick, who is waiting right now, and which
 * app is generating the work. Team-level only — see lib/support-health.ts.
 */
export default async function HealthPage() {
  const { locked } = await gate();
  if (locked) redirect("/login?next=%2Fhealth");
  return (
    <>
      <PageHeader
        title="Support health"
        description="How much is coming in, how fast customers hear back, who is waiting right now, and which apps are driving it."
      />
      <HealthPanel />
    </>
  );
}
