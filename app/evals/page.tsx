import { redirect } from "next/navigation";
import { gate } from "@/lib/console-auth";
import { Nav } from "../nav";
import EvalsPanel from "./evals-panel";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function EvalsPage() {
  const { locked, user } = await gate();
  if (locked) redirect("/login?next=%2Fevals");
  return (
    <div className="mx-auto max-w-4xl space-y-5 px-5 pt-8 pb-20">
      <Nav current="evals" user={user} />
      <EvalsPanel freshdeskDomain={config.freshdesk.domain ?? "jetpackapps.freshdesk.com"} />
    </div>
  );
}
