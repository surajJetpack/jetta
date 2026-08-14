import { redirect } from "next/navigation";
import Link from "next/link";
import { gate } from "@/lib/console-auth";
import { config } from "@/lib/config";
import { Nav } from "../../nav";
import InstallGuide from "./install-guide";

export const dynamic = "force-dynamic";

/** How to put JettaChat on a site, and how to tell why it isn't working. */
export default async function ChatInstallPage() {
  const { locked, user, isAdmin } = await gate();
  if (locked) redirect("/login?next=%2Fchats%2Finstall");
  // Admin-only page. The APIs behind it refuse a general user anyway; this
  // stops them landing on a form whose Save button will just fail.
  if (!isAdmin) redirect("/chats");
  return (
    <div className="mx-auto max-w-4xl space-y-5 px-5 pt-8 pb-20">
      <Nav current="chats" user={user} isAdmin={isAdmin} />
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/chats" className="text-xs text-muted-foreground hover:underline">
          ← All chats
        </Link>
        <Link href="/chats/settings" className="text-xs text-primary hover:underline">
          Chat settings →
        </Link>
      </div>
      <h1 className="text-lg font-semibold tracking-tight">Install JettaChat</h1>
      <InstallGuide baseUrl={config.jettachat.consoleUrl} />
    </div>
  );
}
