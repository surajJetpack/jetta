import { redirect } from "next/navigation";
import { freshdeskDomain } from "@/lib/tools/freshdesk";
import { gate } from "@/lib/console-auth";
import EvalsPanel from "./evals-panel";

export const dynamic = "force-dynamic";

export default async function EvalsPage() {
  const { locked } = await gate();
  if (locked) redirect("/login?next=%2Fevals");
  return (
    <>
      <EvalsPanel freshdeskDomain={freshdeskDomain()} />
    </>
  );
}
