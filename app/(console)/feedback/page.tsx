import { redirect } from "next/navigation";
import { gate } from "@/lib/console-auth";
import { PageHeader } from "@/components/jetta/page-header";
import FeedbackPanel from "./feedback-panel";

export const dynamic = "force-dynamic";

/**
 * What the team told Jetta: ratings of her chat replies (from Chats) and of
 * the console assistant's answers, and
 * every dev-board comment or Freshdesk private note that started with "Jetta feedback:". Admins and CONSOLE_DEV_USERS read it; an admin marks an
 * entry handled. The API route is the boundary.
 */
export default async function FeedbackPage() {
  const { locked, isAdmin } = await gate();
  if (locked) redirect("/login?next=%2Ffeedback");
  return (
    <>
      <PageHeader
        title="Feedback"
        description='What the team told Jetta. Rate her replies on Chats or her answers in the ⌘J panel, or start a dev-item comment or a Freshdesk private note with "Jetta feedback:", and it lands here.'
      />
      <FeedbackPanel canEdit={isAdmin} />
    </>
  );
}
