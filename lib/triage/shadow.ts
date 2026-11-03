/**
 * Shadow triage for GetSign tickets: is this a setup problem the customer can
 * fix, a how-to question, a missing feature, or a real bug in our code?
 *
 * Jetta writes her call as a PRIVATE Freshdesk note on the ticket's first
 * customer message and does nothing else with it. The customer never sees
 * it, the reply agent never reads it, and nothing is routed by it. The point
 * is to measure: the team's own reply on the same ticket grades the call, and
 * after a few weeks we know whether it is good enough to act on.
 *
 * Built offline on 2026-11-03 from 90 days of GetSign tickets (the playbook is
 * lib/triage/getsign-playbook.json). On 29 held-back tickets it called none of
 * the real code bugs a setup problem, the costly mistake.
 *
 * Switch: JETTA_TRIAGE_SHADOW (off unless "on").
 */
import { generateObject } from "ai";
import { z } from "zod";
import { config } from "@/lib/config";
import { getModel } from "@/lib/llm";
import { markEventSeen } from "@/lib/kv";
import { logOpsEvent } from "@/lib/events";
import * as freshdesk from "@/lib/tools/freshdesk";
import type { ConversationContext, Ticket } from "@/lib/types";
import playbook from "./getsign-playbook.json";

const VERDICT = z.object({
  verdict: z.enum(["config", "how_to", "feature_gap", "bug", "unsure"]),
  rule: z.string().describe("The matching playbook rule id, or empty"),
  why: z.string().describe("One or two sentences for a colleague"),
  check: z.string().describe("For config or unsure: what to look at in the customer's GetSign template, board or plan to confirm it. Empty otherwise."),
  askCustomer: z.string().describe("For unsure: the one question that would decide it. Empty otherwise."),
});
export type TriageVerdict = z.infer<typeof VERDICT>;

const PLAYBOOK_TEXT =
  playbook.rules
    .map((r) => `RULE ${r.id} [${r.area}/${r.kind}] ${r.title}\n  says: ${r.symptoms.join(" / ")}\n  check: ${r.check}\n  fix: ${r.fix}`)
    .join("\n") +
  "\n\nCLUES IT IS A REAL BUG:\n" +
  playbook.bugTells.map((t) => `- [${t.area}] ${t.tell}`).join("\n");

export const TRIAGE_SYSTEM = `You triage new GetSign (e-signature app on monday.com) support tickets: is this a CONFIG problem the customer can fix, a HOW_TO question, a FEATURE_GAP, or a real BUG in our code? Say "unsure" rather than guess. Calling a real bug "config" is the worst mistake: the customer gets told to change settings while the bug stays. Use the playbook.

How to decide:
- HOW_TO only when the customer asks how to do something and nothing is broken.
- FEATURE_GAP when they want something GetSign does not do (a missing option, a field type, renaming, bulk actions). It is not a bug and not config.
- "It worked before and stopped": if it stopped on ONE board, workflow or user while others still work, suspect the setup first (the workflow creator or board owner lost access or edit permission, a mapped column was deleted or renamed, the plan changed) and say CONFIG with the check to run, or UNSURE. Say BUG when it broke across boards or customers, right after an app update, or the setup is already confirmed correct.
- If the customer already tried the usual fix (repair, reconnect, reactivate, re-map) and GetSign's own screens block them (confusing or unidentifiable choices, an error in the fix path, the fix does not stick), that is a BUG, not config: never send them back to a fix they already tried.
- Crashes, blank or corrupted PDFs, infinite loading, generic server errors on normal actions: BUG.

PLAYBOOK:
${PLAYBOOK_TEXT}`;

/**
 * What we knew at intake: the subject, the first message, and anything else
 * the customer wrote before our first public reply. Never our answer.
 */
export function intakeText(t: Pick<Ticket, "subject" | "description" | "replies">): string {
  const firstAgent = t.replies.findIndex((r) => r.author === "agent" && !r.isPrivate);
  const before = (firstAgent < 0 ? t.replies : t.replies.slice(0, firstAgent)).filter(
    (r) => r.author === "customer" && !r.isPrivate,
  );
  return [`Subject: ${t.subject}`, "", t.description.slice(0, 2500), ...before.map((r) => r.body.slice(0, 1000))].join("\n");
}

export async function diagnose(t: Pick<Ticket, "subject" | "description" | "replies">): Promise<TriageVerdict> {
  const { object } = await generateObject({
    model: getModel("standard"),
    schema: VERDICT,
    system: TRIAGE_SYSTEM,
    prompt: intakeText(t),
  });
  return object;
}

const LABEL: Record<TriageVerdict["verdict"], string> = {
  config: "Setup problem the customer can fix",
  how_to: "How-to question",
  feature_gap: "Missing feature, not a bug",
  bug: "Likely a bug in GetSign",
  unsure: "Unsure",
};

export function noteText(v: TriageVerdict): string {
  const rule = playbook.rules.find((r) => r.id === v.rule);
  const lines = [
    "🤖 Jetta triage (shadow test, nothing was sent or routed)",
    "",
    `Call: ${LABEL[v.verdict]}${rule ? ` (playbook: ${rule.title})` : ""}`,
    `Why: ${v.why}`,
  ];
  if (v.check) lines.push(`Check: ${v.check}`);
  if (rule && (v.verdict === "config" || v.verdict === "how_to")) lines.push(`Usual fix: ${rule.fix}`);
  if (v.askCustomer) lines.push(`Would decide it: ${v.askCustomer}`);
  lines.push("", "Handle the ticket as usual. Your reply is what grades this call.");
  return lines.join("\n");
}

/** GetSign email/portal tickets only, once per ticket, behind the switch. */
export function shadowTriageApplies(ctx: ConversationContext): boolean {
  return config.triageShadow && ctx.channel === "freshdesk" && !!ctx.ticket && (ctx.app === "getsign" || ctx.product === "getsign");
}

/** Never throws: a failed shadow call must not touch the real run. */
export async function runShadowTriage(ctx: ConversationContext): Promise<void> {
  const t = ctx.ticket;
  if (!t || !shadowTriageApplies(ctx)) return;
  try {
    if (!(await markEventSeen(`triage-shadow:${t.id}`, 180 * 86400))) return;
    const v = await diagnose(t);
    await freshdesk.addPrivateNote(t.id, noteText(v));
    await logOpsEvent({
      level: "info",
      event: "triage.shadow",
      source: "webhook",
      ticketId: t.id,
      data: { verdict: v.verdict, rule: v.rule || null },
    });
  } catch (e) {
    await logOpsEvent({
      level: "warn",
      event: "triage.shadow_failed",
      source: "webhook",
      ticketId: t.id,
      data: { error: e instanceof Error ? e.message : String(e) },
    }).catch(() => {});
  }
}
