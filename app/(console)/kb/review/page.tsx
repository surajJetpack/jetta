import { redirect } from "next/navigation";
import { gate } from "@/lib/console-auth";
import { KbNav } from "../kb-nav";
import KbReview from "../kb-review";
import { countByState } from "@/lib/kb-store";

export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  const { locked } = await gate();
  if (locked) redirect("/login?next=%2Fkb%2Freview");
  const byState = await countByState().catch(() => ({ draft: 0 }));
  return (
    <>
      <KbNav current="review" draftCount={byState.draft} />
      <KbReview />
    </>
  );
}
