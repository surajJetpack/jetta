import { redirect } from "next/navigation";
import { gate } from "@/lib/console-auth";
import { Nav } from "../nav";
import AnalyticsPanel from "../analytics-panel";
import ActivityLog from "../activity-log";
import EventsLog from "../events-log";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const { locked, user } = await gate();
  if (locked) redirect("/login?next=%2Fanalytics");
  return (
    <div className="wrap">
      <Nav current="insights" user={user} />
      <AnalyticsPanel />
      <ActivityLog />
      <EventsLog />
    </div>
  );
}
