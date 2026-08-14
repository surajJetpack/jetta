import { redirect } from "next/navigation";
import Link from "next/link";
import { Suspense } from "react";
import { gate } from "@/lib/console-auth";
import { Nav } from "../nav";
import { listConversations } from "@/lib/chat-store";
import ChatInbox from "./chat-inbox";

export const dynamic = "force-dynamic";

/**
 * The chat inbox: list on the left, conversation on the right.
 *
 * This page is the compensating control for the one safety property chat gives
 * up — on Freshdesk a human reads every reply before the customer does, and
 * here nobody does. It is also now a live surface: someone waiting for a person
 * is pinned to the top, and the open conversation refreshes while you type.
 */
export default async function ChatsPage() {
  const { locked, user, isAdmin, viewingAsGeneral } = await gate();
  if (locked) redirect("/login?next=%2Fchats");

  const conversations = await listConversations(100);

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-5 pt-8 pb-20">
      <Nav current="chats" user={user} isAdmin={isAdmin} canViewAs={isAdmin || viewingAsGeneral} viewingAsGeneral={viewingAsGeneral} />

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-semibold tracking-tight">Chats</h1>
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-xs text-muted-foreground">
            Jetta answers these without review — you are reading after the fact.
          </p>
          {isAdmin && (
            <>
              <Link href="/chats/settings" className="text-xs text-primary hover:underline">
                Settings
              </Link>
              <Link href="/chats/install" className="text-xs text-primary hover:underline">
                Install
              </Link>
            </>
          )}
        </div>
      </div>

      {/* useSearchParams needs a boundary; the list is already rendered above it. */}
      <Suspense fallback={null}>
        <ChatInbox initial={conversations} />
      </Suspense>
    </div>
  );
}
