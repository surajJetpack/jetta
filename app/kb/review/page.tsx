import { gate } from "@/lib/console-auth";
import { Nav, Locked } from "../../nav";
import { KbNav } from "../kb-nav";
import KbReview from "../kb-review";
import { countByState } from "@/lib/kb-store";

export const dynamic = "force-dynamic";

export default async function ReviewPage({ searchParams }: { searchParams: Promise<{ key?: string }> }) {
  const { locked, adminKey } = await gate(searchParams);
  if (locked) return <Locked />;
  const byState = await countByState().catch(() => ({ draft: 0 }));
  return (
    <div className="wrap">
      <Nav current="kb" adminKey={adminKey} />
      <KbNav current="review" adminKey={adminKey} draftCount={byState.draft} />
      <KbReview adminKey={adminKey} />
    </div>
  );
}
