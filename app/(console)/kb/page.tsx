import { redirect } from "next/navigation";
import { gate } from "@/lib/console-auth";
import { KbNav } from "./kb-nav";
import KbList from "./kb-list";
import { countByState } from "@/lib/kb-store";
import { PageHeader } from "@/components/jetta/page-header";

export const dynamic = "force-dynamic";

export default async function KbPage() {
  const { locked } = await gate();
  if (locked) redirect("/login?next=%2Fkb");
  const byState = await countByState().catch(() => ({ draft: 0 }));
  return (
    <>
      <PageHeader
        title="Knowledge Base"
        description="What Jetta knows about the products. Only published articles are searchable by her."
      />
      <KbNav current="list" draftCount={byState.draft} />
      <KbList />
    </>
  );
}
