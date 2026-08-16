import { redirect } from "next/navigation";
import { gate } from "@/lib/console-auth";
import DailyOverview from "@/components/jetta/daily-overview";
import InsightCharts from "@/components/jetta/insight-charts";
import AnalyticsPanel from "./analytics-panel";
import ActivityLog from "./activity-log";
import EventsLog from "./events-log";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const { locked } = await gate();
  if (locked) redirect("/login?next=%2Fanalytics");
  return (
    <>
      <DailyOverview />
      <InsightCharts />
      <AnalyticsPanel />
      <ActivityLog />
      <EventsLog />
    </>
  );
}
