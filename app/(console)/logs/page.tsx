import { redirect } from "next/navigation";
import { gate } from "@/lib/console-auth";
import LogsPanel from "./logs-panel";

export const dynamic = "force-dynamic";

/**
 * Logs & errors: what the apps' errors are doing and who they hit, from Sentry
 * and the CloudWatch server logs, read hourly by the error watch.
 *
 * Admin only, like /dev-board and /performance: it names customer accounts and
 * shows raw errors. The API routes are the real boundary (requireAdmin); the
 * nav merely hides the link. The header lives in the panel because its Run now
 * button and last-run time are client state.
 */
export default async function LogsPage() {
  const { locked } = await gate();
  if (locked) redirect("/login?next=%2Flogs");
  return <LogsPanel />;
}
