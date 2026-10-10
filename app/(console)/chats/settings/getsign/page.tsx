import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Code2 } from "lucide-react";
import { gate } from "@/lib/console-auth";
import { PageHeader } from "@/components/jetta/page-header";
import { Button } from "@/components/ui/button";
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
            <Button variant="ghost" size="sm" asChild>
              <Link href="/chats/settings">
                <ArrowLeft />
                Chat settings
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href="/chats/install">
                <Code2 />
                Install
              </Link>
            </Button>
          </>
        }
      />
      <GetSignSkinForm />
    </>
  );
}
