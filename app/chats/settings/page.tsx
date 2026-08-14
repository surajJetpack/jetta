import { redirect } from "next/navigation";
import Link from "next/link";
import { gate } from "@/lib/console-auth";
import { Nav } from "../../nav";
import ChatSettingsForm from "./settings-form";

export const dynamic = "force-dynamic";

/**
 * JettaChat's control panel. Everything here takes effect without a deploy —
 * except the two switches that deliberately live in the environment: the
 * signing secret, and JETTACHAT_LIVE.
 */
export default async function ChatSettingsPage() {
  const { locked, user, isAdmin, viewingAsGeneral } = await gate();
  if (locked) redirect("/login?next=%2Fchats%2Fsettings");
  // Admin-only page. The APIs behind it refuse a general user anyway; this
  // stops them landing on a form whose Save button will just fail.
  if (!isAdmin) redirect("/chats");
  return (
    <div className="mx-auto max-w-4xl space-y-5 px-5 pt-8 pb-20">
      <Nav current="chats" user={user} isAdmin={isAdmin} canViewAs={isAdmin || viewingAsGeneral} viewingAsGeneral={viewingAsGeneral} />
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/chats" className="text-xs text-muted-foreground hover:underline">
          ← All chats
        </Link>
        <Link href="/chats/install" className="text-xs text-primary hover:underline">
          Installation instructions →
        </Link>
      </div>
      <h1 className="text-lg font-semibold tracking-tight">Chat settings</h1>
      <ChatSettingsForm />
    </div>
  );
}
