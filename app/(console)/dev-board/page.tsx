import { redirect } from "next/navigation";
import { gate } from "@/lib/console-auth";
import { PageHeader } from "@/components/jetta/page-header";
import DevBoardPanel from "./dev-board-panel";

export const dynamic = "force-dynamic";

/**
 * The monday dev boards read as a team: how client issues move between support
 * and engineering, what support does on the boards, and what the conversations
 * on items teach.
 *
 * Admin only, like /performance and /activity: rows name people. The API
 * routes are the real boundary (requireAdmin); the nav merely hides the link.
 */
export default async function DevBoardPage() {
  const { locked } = await gate();
  if (locked) redirect("/login?next=%2Fdev-board");
  return (
    <>
      <PageHeader
        title="Dev board"
        description="Client issues on the monday dev boards — pace, whose move, support's part, and what the conversations teach."
      />
      <DevBoardPanel />
    </>
  );
}
