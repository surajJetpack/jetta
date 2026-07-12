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
    <div className="wrap">
      <Nav current="evals" user={user} />
      <EvalsPanel freshdeskDomain={config.freshdesk.domain ?? "jetpackapps.freshdesk.com"} />
    </div>
  );
}
