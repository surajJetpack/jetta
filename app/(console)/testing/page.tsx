import { redirect } from "next/navigation";
import { gate } from "@/lib/console-auth";
import { allPlaybookProgress, getPlaybookProgress } from "@/lib/kv";
import { PageHeader } from "@/components/jetta/page-header";
import PlaybookContent from "./playbook-content";

export const dynamic = "force-dynamic";

/**
 * The manual test playbook: scripted scenarios anyone on the team runs by
 * acting as a customer. Each one doubles as training — the "how Jetta does
 * this" notes are the mechanism behind the expected behavior. Visible to
 * every signed-in user; progress is per-person and everyone can see
 * everyone's, which is most of the motivation.
 */
export default async function TestingPage() {
  const { locked, user } = await gate();
  if (locked) redirect("/login?next=%2Ftesting");
  const everyone = await allPlaybookProgress().catch(() => ({}) as Record<string, never>);
  const mine = everyone[user] ?? (await getPlaybookProgress(user).catch(() => ({})));
  return (
    <>
      <PageHeader
        title="Test Jetta"
        description="Play the customer, watch what she does, and learn how she does it. Two tracks, about 45 minutes each."
      />
      <PlaybookContent user={user} initialMine={mine} team={everyone} />
    </>
  );
}
