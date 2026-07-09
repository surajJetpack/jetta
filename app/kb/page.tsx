import { redirect } from "next/navigation";
import { gate } from "@/lib/console-auth";
import { Nav } from "../nav";
import { KbNav } from "./kb-nav";
import KbList from "./kb-list";
import { countByState } from "@/lib/kb-store";

export const dynamic = "force-dynamic";

export default async function KbPage() {
  const { locked, user } = await gate();
  if (locked) redirect("/login?next=%2Fkb");
  const byState = await countByState().catch(() => ({ draft: 0 }));
  return (
    <div className="wrap">
      <Nav current="kb" user={user} />
      <KbNav current="list" draftCount={byState.draft} />
      <KbList />
    </div>
  );
}
