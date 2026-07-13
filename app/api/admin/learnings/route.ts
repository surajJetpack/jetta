/**
 * Learnings CRUD for the /evals console (admin-gated).
 *
 *   GET  → { learnings }            (candidates first, then by strength)
 *   GET ?preview=<product> → also { block } — the exact LEARNED GUIDELINES
 *          text that would be injected into the system prompt for that product.
 *   POST { id, action: "approve" | "reject" | "retire", text? }
 *   POST { action: "create", text, category, product }   (manual seed rule)
 *
 * State machine: candidate → approved|rejected; approved → retired.
 * Approving a revision (candidate with `supersedes`) retires the learning it
 * replaces. Only approved learnings are injected into replies.
 */
import { NextRequest, NextResponse } from "next/server";
import { adminAuthorized, adminActor } from "@/lib/auth";
import {
  EVAL_TAGS,
  addLearning,
  getLearning,
  getLearningsBlock,
  listLearnings,
  updateLearning,
  type EvalTag,
  type LearningProduct,
} from "@/lib/evals";
import { logOpsEvent } from "@/lib/events";

/** Audit trail for learning state changes (the record itself is overwritten). */
async function logLearningEvent(
  action: "created" | "approved" | "rejected" | "retired",
  actor: string,
  learning: { id: string; text: string; supersedes?: string },
): Promise<void> {
  await logOpsEvent({
    level: "info",
    event: `learning.${action}`,
    source: "console",
    actor,
    data: {
      learningId: learning.id,
      text: learning.text.slice(0, 120),
      supersedes: learning.supersedes,
    },
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_RANK = { candidate: 0, approved: 1, retired: 2, rejected: 3 } as const;

export async function GET(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const learnings = await listLearnings();
  learnings.sort(
    (a, b) =>
      STATE_RANK[a.state] - STATE_RANK[b.state] ||
      b.reinforcedCount - a.reinforcedCount ||
      b.updatedAt - a.updatedAt,
  );
  const preview = req.nextUrl.searchParams.get("preview");
  if (preview) {
    const block = await getLearningsBlock(preview);
    return NextResponse.json({ learnings, block });
  }
  return NextResponse.json({ learnings });
}

export async function POST(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id, action, text, category, product } = (await req.json().catch(() => ({}))) as {
    id?: string;
    action?: string;
    text?: string;
    category?: string;
    product?: string;
  };
  const actor = adminActor(req) ?? "console";
  const now = Math.floor(Date.now() / 1000);

  if (action === "create") {
    if (!text?.trim()) return NextResponse.json({ error: "text required" }, { status: 400 });
    const cat: EvalTag = (EVAL_TAGS as readonly string[]).includes(category ?? "")
      ? (category as EvalTag)
      : "other";
    const prod: LearningProduct =
      product === "getsign" || product === "jetpackapps" ? product : "all";
    const learning = await addLearning({
      text: text.trim(),
      category: cat,
      product: prod,
      state: "approved", // manual rules are human-authored — no review step needed
      decidedBy: actor,
      sourceEvalIds: [],
      reinforcedCount: 0,
      rationale: "manually added",
    });
    await logLearningEvent("created", actor, learning);
    return NextResponse.json({ ok: true, learning });
  }

  if (!id || (action !== "approve" && action !== "reject" && action !== "retire")) {
    return NextResponse.json(
      { error: "id and action (approve|reject|retire) required, or action create" },
      { status: 400 },
    );
  }

  const learning = await getLearning(id);
  if (!learning) return NextResponse.json({ error: "learning not found" }, { status: 404 });

  if (action === "retire") {
    if (learning.state !== "approved") {
      return NextResponse.json({ error: `cannot retire a ${learning.state} learning` }, { status: 409 });
    }
    await updateLearning(id, { state: "retired", decidedBy: actor });
    await logLearningEvent("retired", actor, learning);
    return NextResponse.json({ ok: true, action: "retired" });
  }

  if (learning.state !== "candidate") {
    return NextResponse.json({ error: `learning is already ${learning.state}` }, { status: 409 });
  }

  if (action === "reject") {
    await updateLearning(id, { state: "rejected", decidedBy: actor });
    await logLearningEvent("rejected", actor, learning);
    return NextResponse.json({ ok: true, action: "rejected" });
  }

  // approve — accepts an edited text; a revision retires what it supersedes.
  await updateLearning(id, {
    state: "approved",
    decidedBy: actor,
    ...(text?.trim() ? { text: text.trim() } : {}),
  });
  if (learning.supersedes) {
    const old = await getLearning(learning.supersedes);
    if (old && old.state === "approved") {
      await updateLearning(old.id, { state: "retired", decidedBy: actor });
      await logLearningEvent("retired", actor, old);
    }
  }
  await logLearningEvent("approved", actor, { ...learning, text: text?.trim() || learning.text });
  return NextResponse.json({ ok: true, action: "approved", decidedAt: now });
}
