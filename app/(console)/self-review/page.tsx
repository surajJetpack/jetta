import { redirect } from "next/navigation";
import { gate } from "@/lib/console-auth";
import SelfReviewPanel from "./self-review-panel";

export const dynamic = "force-dynamic";

/**
 * Self-review: Jetta checking her own work, hourly. Reliability of her jobs
 * and runs, and an independent model's grades on her recent replies.
 *
 * Admin only, like /logs: it quotes customer messages. The API route is the
 * real boundary (requireAdmin); the nav merely hides the link.
 */
export default async function SelfReviewPage() {
  const { locked } = await gate();
  if (locked) redirect("/login?next=%2Fself-review");
  return <SelfReviewPanel />;
}
