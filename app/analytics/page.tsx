import { redirect } from "next/navigation";
import { gate } from "@/lib/console-auth";
import DailyOverview from "@/components/jetta/daily-overview";
import InsightCharts from "@/components/jetta/insight-charts";
import { Nav } from "../nav";
import AnalyticsPanel from "../analytics-panel";
import ActivityLog from "../activity-log";
import EventsLog from "../events-log";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const { locked, user } = await gate();
  if (locked) redirect("/login?next=%2Fanalytics");
  return (
    <div className="mx-auto max-w-4xl space-y-5 px-5 pt-8 pb-20">
      <Nav current="insights" user={user} />
      <DailyOverview />
      <InsightCharts />
      <AnalyticsPanel />
      <ActivityLog />
      <EventsLog />
    </div>
  );
}
