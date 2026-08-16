import { redirect } from "next/navigation";
import { freshdeskDomain } from "@/lib/tools/freshdesk";
import { gate } from "@/lib/console-auth";
import DraftsQueue from "./drafts-queue";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function DraftsPage() {
  const { locked } = await gate();
  if (locked) redirect("/login?next=%2Fdrafts");
  return (
    <>
      <DraftsQueue
        replyMode={config.replyMode}
        freshdeskDomain={freshdeskDomain()}
      />
    </>
  );
}
