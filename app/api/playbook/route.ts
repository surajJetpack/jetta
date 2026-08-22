/**
 * Progress for the manual test playbook (/testing).
 *
 * Any signed-in console user, no role check: running the playbook is exactly
 * the job we want general users doing, and nothing here touches Jetta's
 * behavior — it's a scoreboard. Progress is stored under the SESSION username,
 * never a client-supplied one, so nobody can tick a teammate's boxes.
 */
import { NextRequest, NextResponse } from "next/server";
import { gate } from "@/lib/console-auth";
import {
  getPlaybookProgress,
  savePlaybookProgress,
  allPlaybookProgress,
} from "@/lib/kv";
import { scenarioIds, type ScenarioProgress } from "@/lib/test-playbook";

export const dynamic = "force-dynamic";

export async function GET() {
  const { locked, user } = await gate();
  if (locked) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const everyone = await allPlaybookProgress();
  return NextResponse.json({
    user,
    mine: everyone[user] ?? {},
    others: Object.entries(everyone)
      .filter(([name]) => name !== user)
      .map(([name, progress]) => ({
        name,
        done: Object.values(progress).filter((s) => s.outcome).length,
      })),
  });
}

export async function POST(req: NextRequest) {
  const { locked, user } = await gate();
  if (locked) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const body = (await req.json().catch(() => null)) as {
    scenarioId?: string;
    checks?: string[];
    outcome?: "pass" | "fail" | null;
    note?: string;
  } | null;
  if (!body?.scenarioId || !scenarioIds().has(body.scenarioId)) {
    return NextResponse.json({ error: "Unknown scenario." }, { status: 400 });
  }

  const progress = await getPlaybookProgress(user);
  const prev = progress[body.scenarioId];
  const entry: ScenarioProgress = {
    checks: Array.isArray(body.checks)
      ? body.checks.filter((c) => typeof c === "string").slice(0, 20)
      : (prev?.checks ?? []),
    updatedAt: new Date().toISOString(),
  };
  // outcome: undefined = keep, null = clear, value = set.
  const outcome = body.outcome === undefined ? prev?.outcome : (body.outcome ?? undefined);
  if (outcome) entry.outcome = outcome;
  const note = body.note !== undefined ? body.note.slice(0, 2000) : prev?.note;
  if (note) entry.note = note;

  progress[body.scenarioId] = entry;
  await savePlaybookProgress(user, progress);
  return NextResponse.json({ ok: true, entry });
}
