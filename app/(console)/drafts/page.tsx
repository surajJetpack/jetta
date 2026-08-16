import { redirect } from "next/navigation";
import { freshdeskDomain } from "@/lib/tools/freshdesk";
import { gate } from "@/lib/console-auth";
import DraftsQueue from "./drafts-queue";
import { config } from "@/lib/config";
import { PageHeader } from "@/components/jetta/page-header";

export const dynamic = "force-dynamic";

export default async function DraftsPage() {
  const { locked } = await gate();
  if (locked) redirect("/login?next=%2Fdrafts");
  return (
    <>
      <PageHeader
        title="Suggestions"
        description="Every reply Jetta proposed, kept as an audit trail. Not a queue anyone works — the private note on the ticket is."
      />
      <DraftsQueue
        replyMode={config.replyMode}
        freshdeskDomain={freshdeskDomain()}
      />
    </>
  );
}
