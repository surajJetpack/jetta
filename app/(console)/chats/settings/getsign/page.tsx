import { redirect } from "next/navigation";
import Link from "next/link";
import { gate } from "@/lib/console-auth";
import { PageHeader } from "@/components/jetta/page-header";
import GetSignSkinForm from "./getsign-form";

export const dynamic = "force-dynamic";

/**
 * GetSign's own skin. Only what GetSign overrides lives here — the channel's
 * behaviour, origins, limits and retention are one set of settings for every
 * brand and stay on the main page, so there is no screen on which someone can
 * believe they are setting a rate limit "just for GetSign".
 */
export default async function GetSignSettingsPage() {
  const { locked, isAdmin } = await gate();
  if (locked) redirect("/login?next=%2Fchats%2Fsettings%2Fgetsign");
  if (!isAdmin) redirect("/chats");
  return (
    <>
      <PageHeader
        title="GetSign skin"
        description="What a visitor on getsign.io sees. Anything left blank is inherited from the default skin."
        actions={
          <>
            <Link href="/chats/settings" className="text-xs text-muted-foreground hover:underline">
              ← Chat settings
            </Link>
            <Link href="/chats/install" className="text-xs text-primary hover:underline">
              Install →
            </Link>
          </>
        }
      />
      <GetSignSkinForm />
    </>
  );
}
