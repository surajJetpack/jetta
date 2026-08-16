import { redirect } from "next/navigation";
import { gate } from "@/lib/console-auth";
import { PageHeader } from "@/components/jetta/page-header";
import GuideContent from "./guide-content";

export const dynamic = "force-dynamic";

/**
 * The guide is role-aware: an admin reads everything, a general user reads the
 * six cards that describe their own job. Both come from one component — see the
 * note in guide-content.tsx for why this isn't two files.
 */
export default async function GuidePage() {
  const { locked, isAdmin } = await gate();
  if (locked) redirect("/login?next=%2Fguide");
  return (
    <>
      <PageHeader
        title="Guide"
        description={
          isAdmin
            ? "How Jetta works, what needs you, and what only you can change."
            : "How Jetta works and what needs you. Three minutes."
        }
      />
      <GuideContent isAdmin={isAdmin} />
    </>
  );
}
