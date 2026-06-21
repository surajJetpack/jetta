import { gate } from "@/lib/console-auth";
import { Nav, Locked } from "../nav";
import AnalyticsPanel from "../analytics-panel";
import ActivityLog from "../activity-log";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ key?: string }> }) {
  const { locked, adminKey } = await gate(searchParams);
  if (locked) return <Locked />;
  return (
    <div className="wrap">
      <Nav current="insights" adminKey={adminKey} />
      <AnalyticsPanel adminKey={adminKey} />
      <ActivityLog adminKey={adminKey} />
    </div>
  );
}
