import { redirect } from "next/navigation";
import { gate } from "@/lib/console-auth";
import GuideContent from "./guide-content";

export const dynamic = "force-dynamic";

export default async function GuidePage() {
  const { locked } = await gate();
  if (locked) redirect("/login?next=%2Fguide");
  return (
    <>
      <GuideContent />
    </>
  );
}
