import { redirect } from "next/navigation";
import { gate } from "@/lib/console-auth";
import { Nav } from "../nav";
import DraftsQueue from "./drafts-queue";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function DraftsPage() {
  const { locked, user } = await gate();
  if (locked) redirect("/login?next=%2Fdrafts");
  return (
    <div className="mx-auto max-w-4xl space-y-5 px-5 pt-8 pb-20">
      <Nav current="drafts" user={user} />
      <DraftsQueue
        replyMode={config.replyMode}
        freshdeskDomain={config.freshdesk.domain ?? "jetpackapps.freshdesk.com"}
      />
    </div>
  );
}
