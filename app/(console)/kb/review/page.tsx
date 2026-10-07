import { redirect } from "next/navigation";
import { gate } from "@/lib/console-auth";
import { KbNav } from "../kb-nav";
import KbReview from "../kb-review";
import { countByState } from "@/lib/kb-store";
import { PageHeader } from "@/components/jetta/page-header";

export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  const { locked } = await gate();
  if (locked) redirect("/login?next=%2Fkb%2Freview");
  // Open to the whole support team since 2026-10-07: the people answering the
  // tickets are the ones who know whether a draft is right, and every action
  // on this page works for them (see app/api/admin/kb/drafts/route.ts).
  const byState = await countByState().catch(() => ({ draft: 0 }));
  return (
    <>
      <PageHeader
        title="Review queue"
        description="Draft articles waiting to be published. Nothing here is searchable by Jetta yet."
      />
      <KbNav current="review" draftCount={byState.draft} />
      <KbReview />
    </>
  );
}
