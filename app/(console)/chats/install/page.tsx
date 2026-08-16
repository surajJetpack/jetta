import { redirect } from "next/navigation";
import Link from "next/link";
import { gate } from "@/lib/console-auth";
import { config } from "@/lib/config";
import { PageHeader } from "@/components/jetta/page-header";
import InstallGuide from "./install-guide";

export const dynamic = "force-dynamic";

/** How to put JettaChat on a site, and how to tell why it isn't working. */
export default async function ChatInstallPage() {
  const { locked, isAdmin } = await gate();
  if (locked) redirect("/login?next=%2Fchats%2Finstall");
  // Admin-only page. The APIs behind it refuse a general user anyway; this
  // stops them landing on a form whose Save button will just fail.
  if (!isAdmin) redirect("/chats");
  return (
    <>
      <PageHeader
        title="Install JettaChat"
        description="Drop the widget onto a site. Which origins may embed it is a security decision — set that in Chat settings."
        actions={
          <>
            <Link href="/chats" className="text-xs text-muted-foreground hover:underline">
              All chats
            </Link>
            <Link href="/chats/settings" className="text-xs text-primary hover:underline">
              Settings →
            </Link>
          </>
        }
      />
      <InstallGuide baseUrl={config.jettachat.consoleUrl} />
    </>
  );
}
