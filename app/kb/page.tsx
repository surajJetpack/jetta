import { gate } from "@/lib/console-auth";
import { Nav, Locked } from "../nav";
import KbManager from "../kb-manager";

export const dynamic = "force-dynamic";

export default async function KbPage({ searchParams }: { searchParams: Promise<{ key?: string }> }) {
  const { locked, adminKey } = await gate(searchParams);
  if (locked) return <Locked />;
  return (
    <div className="wrap">
      <Nav current="kb" adminKey={adminKey} />
      <KbManager adminKey={adminKey} />
    </div>
  );
}
