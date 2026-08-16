import { redirect } from "next/navigation";

/**
 * The front door is the morning brief.
 *
 * This route used to be a diagnostics screen — status tiles, ticket tester,
 * endpoint list — which meant the first thing anyone saw was a page written
 * for whoever operates Jetta rather than for the four people who use her. That
 * content now lives at /system, where it reads as a deliberate destination
 * instead of a landing page.
 */
export default function RootPage() {
  redirect("/today");
}
