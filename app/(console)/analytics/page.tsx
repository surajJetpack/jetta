import { redirect } from "next/navigation";
import { gate } from "@/lib/console-auth";
import { PageHeader } from "@/components/jetta/page-header";
import { SectionNav, SectionAnchor, type Section } from "@/components/jetta/section-nav";
import DailyOverview from "@/components/jetta/daily-overview";
import InsightCharts from "@/components/jetta/insight-charts";
import AnalyticsPanel from "./analytics-panel";
import ActivityLog from "./activity-log";
import EventsLog from "./events-log";

export const dynamic = "force-dynamic";

/**
 * Insights is five independent panels, and it used to render them as one
 * endless scroll — so reaching the event log to answer "why did that happen"
 * meant scrolling past four things you weren't looking for.
 *
 * They stay on one route rather than splitting across five: during an
 * investigation you read them together, and each is cheap to render. What they
 * gain is a sticky jump-bar, so the page is navigable instead of merely long.
 */
const SECTIONS: Section[] = [
  { id: "overview", label: "Yesterday" },
  { id: "trends", label: "Volume & cost" },
  { id: "quality", label: "Learning & gaps" },
  { id: "runs", label: "Runs" },
  { id: "events", label: "Event log" },
];

export default async function AnalyticsPage() {
  const { locked } = await gate();
  if (locked) redirect("/login?next=%2Fanalytics");
  return (
    <>
      <PageHeader
        title="Insights"
        description="How Jetta is doing — volume, cost, quality, and every event she recorded."
      />
      <SectionNav sections={SECTIONS} />

      <SectionAnchor id="overview">
        <DailyOverview />
      </SectionAnchor>
      <SectionAnchor id="trends">
        <InsightCharts />
      </SectionAnchor>
      <SectionAnchor id="quality">
        <AnalyticsPanel />
      </SectionAnchor>
      <SectionAnchor id="runs">
        <ActivityLog />
      </SectionAnchor>
      <SectionAnchor id="events">
        <EventsLog />
      </SectionAnchor>
    </>
  );
}
