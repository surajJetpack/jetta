import { redirect } from "next/navigation";
import { freshdeskDomain } from "@/lib/tools/freshdesk";
import Link from "next/link";
import { Suspense } from "react";
import { gate } from "@/lib/console-auth";
import { listConversations } from "@/lib/chat-store";
import ChatInbox from "./chat-inbox";
import { PageHeader } from "@/components/jetta/page-header";

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
  const { locked, isAdmin } = await gate();
  if (locked) redirect("/login?next=%2Fchats");

  const conversations = await listConversations(100);

  return (
    <>
      <PageHeader
        title="Chats"
        description="Jetta answers these without review — you are reading after the fact."
        actions={
          isAdmin && (
            <>
              <Link href="/chats/settings" className="text-xs text-primary hover:underline">
                Settings
              </Link>
              <Link href="/chats/install" className="text-xs text-primary hover:underline">
                Install
              </Link>
            </>
          )
        }
      />

      {/* useSearchParams needs a boundary; the list is already rendered above it. */}
      <Suspense fallback={null}>
        <ChatInbox initial={conversations} freshdeskDomain={freshdeskDomain()} />
      </Suspense>
    </>
  );
}
