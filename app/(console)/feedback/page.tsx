import { redirect } from "next/navigation";
import { gate } from "@/lib/console-auth";
import { PageHeader } from "@/components/jetta/page-header";
import FeedbackPanel from "./feedback-panel";

export const dynamic = "force-dynamic";

/**
 * What the team told Jetta: ratings of the console assistant's answers, and
 * every dev-board comment that started with "Jetta feedback:". Admins and CONSOLE_DEV_USERS read it; an admin marks an
 * entry handled. The API route is the boundary.
 */
export default async function FeedbackPage() {
  const { locked, isAdmin } = await gate();
  if (locked) redirect("/login?next=%2Ffeedback");
  return (
    <>
      <PageHeader
        title="Feedback"
        description='What the team told Jetta. Rate an answer in the ⌘J panel, or start a comment on a dev item with "Jetta feedback:", and it lands here.'
      />
      <FeedbackPanel canEdit={isAdmin} />
    </>
  );
}
