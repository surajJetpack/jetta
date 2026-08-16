import { redirect } from "next/navigation";

/**
 * Deep links (the Slack handoff ping, older bookmarks) land here and are sent
 * to the inbox with that conversation selected — one surface rather than two
 * that drift apart.
 */
export default async function ChatDetailRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/chats?c=${encodeURIComponent(id)}`);
}
