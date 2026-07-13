/**
 * On-demand distillation (the "Distill now" button in /evals).
 *
 *   POST → { consumed, created, reinforced, revised }
 *
 * Feeds undistilled evaluations + the full learning set (including rejected /
 * retired, so nothing is re-proposed) to lib/distill.ts, then applies:
 *   new       → candidate learning awaiting human review
 *   reinforce → bump reinforcedCount on the referenced learning
 *   revise    → candidate with `supersedes` set; the live learning is retired
 *               only when a human approves the revision
 * Nothing reaches the system prompt without approval in /evals.
 */
import { NextRequest, NextResponse } from "next/server";
import { adminAuthorized, adminActor } from "@/lib/auth";
import {
  addLearning,
  getUndistilledEvaluations,
  listLearnings,
  markDistilled,
  updateLearning,
} from "@/lib/evals";
import { distillEvaluations } from "@/lib/distill";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const BATCH_CAP = 25;

export async function POST(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const actor = adminActor(req) ?? "console";

  const [pending, learnings] = await Promise.all([getUndistilledEvaluations(), listLearnings()]);
  if (!pending.length) {
    return NextResponse.json({ consumed: 0, created: 0, reinforced: 0, revised: 0 });
  }
  const batch = pending.slice(0, BATCH_CAP);

  let proposals;
  try {
    proposals = await distillEvaluations(batch, learnings);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn("distill.failed", { error: msg, actor, source: "console" });
    // Nothing written — evaluations stay undistilled and retryable.
    return NextResponse.json({ error: `distillation failed: ${msg}` }, { status: 502 });
  }

  let created = 0;
  let reinforced = 0;
  let revised = 0;
  const learningIdsByEval = new Map<string, string[]>();
  const link = (evalIds: string[], learningId: string) => {
    for (const id of evalIds) {
      learningIdsByEval.set(id, [...(learningIdsByEval.get(id) ?? []), learningId]);
    }
  };

  for (const p of proposals) {
    if (p.kind === "reinforce" && p.learningId) {
      const l = learnings.find((x) => x.id === p.learningId);
      if (!l || (l.state !== "approved" && l.state !== "candidate")) continue;
      await updateLearning(p.learningId, {
        reinforcedCount: l.reinforcedCount + 1,
        sourceEvalIds: [...new Set([...l.sourceEvalIds, ...p.sourceEvalIds])],
      });
      link(p.sourceEvalIds, p.learningId);
      reinforced++;
    } else if (p.kind === "revise" && p.learningId) {
      const added = await addLearning({
        text: p.text,
        category: p.category,
        product: p.product,
        state: "candidate",
        sourceEvalIds: p.sourceEvalIds,
        reinforcedCount: 0,
        supersedes: p.learningId,
        rationale: p.rationale,
      });
      link(p.sourceEvalIds, added.id);
      revised++;
    } else if (p.kind === "new") {
      const added = await addLearning({
        text: p.text,
        category: p.category,
        product: p.product,
        state: "candidate",
        sourceEvalIds: p.sourceEvalIds,
        reinforcedCount: 0,
        rationale: p.rationale,
      });
      link(p.sourceEvalIds, added.id);
      created++;
    }
  }

  await markDistilled(batch.map((e) => e.id), learningIdsByEval);
  log.info("distill.completed", { consumed: batch.length, created, reinforced, revised, actor, source: "console" });
  return NextResponse.json({ consumed: batch.length, created, reinforced, revised });
}
