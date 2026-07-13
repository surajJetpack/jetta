import { redirect } from "next/navigation";
import { gate } from "@/lib/console-auth";
import { Nav } from "../nav";
import GuideContent from "./guide-content";

export const dynamic = "force-dynamic";

export default async function GuidePage() {
  const { locked, user } = await gate();
  if (locked) redirect("/login?next=%2Fguide");
  return (
    <div className="wrap">
      <Nav current="guide" user={user} />
      <GuideContent />
    </div>
  );
}
