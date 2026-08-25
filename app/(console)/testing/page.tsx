import { redirect } from "next/navigation";
import { gate, parseUsers } from "@/lib/console-auth";
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
  const saved = await allPlaybookProgress().catch(() => ({}) as Record<string, never>);
  const mine = saved[user] ?? (await getPlaybookProgress(user).catch(() => ({})));
  // Seed the roster from CONSOLE_USERS so teammates show up at 0/N before they
  // have ticked anything — otherwise the team view is just you until someone
  // else saves progress, which reads as "nobody else is on this".
  const team: Record<string, typeof mine> = {};
  for (const name of parseUsers().keys()) team[name] = saved[name] ?? {};
  for (const [name, progress] of Object.entries(saved)) team[name] = progress;
  team[user] = mine;
  return (
    <>
      <PageHeader
        title="Test Jetta"
        description="Play the customer, watch what she does, and learn how she does it. About 45 minutes, one scenario at a time."
      />
      <PlaybookContent user={user} initialMine={mine} team={team} />
    </>
  );
}
