import { redirect } from "next/navigation";
import Link from "next/link";
import { Code2, MessagesSquare } from "lucide-react";
import { gate } from "@/lib/console-auth";
import { PageHeader } from "@/components/jetta/page-header";
import { Button } from "@/components/ui/button";
import ChatSettingsForm from "./settings-form";

export const dynamic = "force-dynamic";

/**
 * JettaChat's control panel. Everything here takes effect without a deploy —
 * except the two switches that deliberately live in the environment: the
 * signing secret, and JETTACHAT_LIVE.
 */
export default async function ChatSettingsPage() {
  const { locked, isAdmin } = await gate();
  if (locked) redirect("/login?next=%2Fchats%2Fsettings");
  // Admin-only page. The APIs behind it refuse a general user anyway; this
  // stops them landing on a form whose Save button will just fail.
  if (!isAdmin) redirect("/chats");
  return (
    <>
      <PageHeader
        title="Chat settings"
        description="Everything here takes effect without a deploy."
        actions={
          <>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/chats">
                <MessagesSquare />
                All chats
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
      <ChatSettingsForm />
      <p className="text-xs text-muted-foreground">
        Where the &quot;a visitor wants a person&quot; ping goes, and whether Jetta can post there, is
        on{" "}
        <Link href="/system" className="text-primary hover:underline">
          System
        </Link>{" "}
        with the rest of the channel routing.
      </p>
    </>
  );
}
