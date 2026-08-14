import { redirect } from "next/navigation";
import { gate } from "@/lib/console-auth";
import { Nav } from "../nav";
import GuideContent from "./guide-content";

export const dynamic = "force-dynamic";

export default async function GuidePage() {
  const { locked, user, isAdmin, viewingAsGeneral } = await gate();
  if (locked) redirect("/login?next=%2Fguide");
  return (
    <div className="mx-auto max-w-4xl space-y-5 px-5 pt-8 pb-20">
      <Nav current="guide" user={user} isAdmin={isAdmin} canViewAs={isAdmin || viewingAsGeneral} viewingAsGeneral={viewingAsGeneral} />
      <GuideContent />
    </div>
  );
}
