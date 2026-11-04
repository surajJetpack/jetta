/**
 * Self-review, part 3: what Jetta DID, not what she wrote. No model.
 *
 * Her riskiest work is unsupervised writes: dev items filed on the board,
 * comments posted to developers as Suraj, tickets closed, billing changes. The
 * tools already guard most mistakes (dedupe on filing, a chase limit, one post
 * per turn, no answering a hand-off), and every incident so far was one of
 * those guards being bypassed: a second item for 14457 (the dedupe skips Done
 * items), three pings on #14591, a ticket closed while still escalated (14453).
 * So these rules read the tool calls in the run logs and name each time it
 * happened anyway:
 *   - duplicate_dev_item   more than one new dev item or question for one ticket
 *   - repeated_dev_post    the same post to developers twice on one ticket within 24h
 *   - closed_while_escalated  close_ticket after a dev item / escalation on that ticket
 *   - thin_dev_item        a dev item filed with almost no repro steps
 *   - dev_write_failed     a board write she meant to make that did not land
 *   - cancelled_subscription  any cancel; policy says only on the customer's explicit ask
 * Pure over the run logs (`assessActions`), testable offline.
 */
import type { RunLog } from "../kv";
import { replySimilarity } from "../reply-similarity";
import type { ActionFinding, ActionReport } from "./types";

const DAY = 86_400_000;
const WINDOW_DAYS = 7;

type Call = { run: RunLog; tool: string; input: Record<string, unknown>; result: string };

function callsOf(run: RunLog): Call[] {
  return (run.trace ?? []).map((t) => ({
    run,
    tool: t.tool,
    input: (t.input ?? {}) as Record<string, unknown>,
    result: typeof t.result === "string" ? t.result : JSON.stringify(t.result ?? ""),
  }));
}

/** A real board write that created something new (not a dry run, not a dedupe, not shadow). */
const filedNew = (c: Call) =>
  (c.tool === "create_dev_item" && /^Created Dev board item/.test(c.result)) ||
  (c.tool === "ask_devs" && /^Asked the developers: filed/.test(c.result));
const postedToDevs = (c: Call) => (c.tool === "reply_on_dev_item" || c.tool === "update_dev_item") && /^Posted on dev item/.test(c.result);
const escalation = (c: Call) => filedNew(c) || c.tool === "send_escalation" || (c.tool === "create_dev_item" && /ALREADY has Dev board item/.test(c.result));
/** A close that really happened: a ticket (not a chat), not held for a person in draft mode. */
const closedTicket = (c: Call) => c.tool === "close_ticket" && c.result.startsWith("Ticket marked resolved") && !c.run.heldCustomerWrites;
/** What a post to developers said (update_dev_item's chase has no message of its own). */
const postText = (c: Call) => String(c.input.message ?? "").trim();
/** Two posts this alike say the same thing. */
const REPEAT = 0.8;
const WRITE_TOOLS = new Set(["create_dev_item", "ask_devs", "reply_on_dev_item", "update_dev_item", "send_to_compliance"]);
const writeFailed = (c: Call) =>
  WRITE_TOOLS.has(c.tool) && /monday writes are off|could not be read|failed to upload|^Error|error:/i.test(c.result);

export function assessActions(logs: RunLog[], now: number): ActionReport {
  const recent = logs.filter((l) => now - l.at * 1000 < WINDOW_DAYS * DAY && !l.dryRun);
  const calls = recent.flatMap(callsOf);
  const byTicket = new Map<string, Call[]>();
  for (const c of calls) {
    const list = byTicket.get(c.run.ticketId) ?? [];
    list.push(c);
    byTicket.set(c.run.ticketId, list);
  }
  const findings: ActionFinding[] = [];
  const at = (c: Call) => c.run.at * 1000;

  for (const [ticketId, cs] of byTicket) {
    const sorted = [...cs].sort((a, b) => at(a) - at(b));

    const filed = sorted.filter(filedNew);
    if (filed.length > 1) {
      findings.push({
        key: `duplicate_dev_item:${ticketId}`,
        rule: "duplicate_dev_item",
        severity: "bad",
        ticketId,
        at: at(filed[filed.length - 1]),
        title: `${filed.length} dev items filed for ticket ${ticketId}`,
        detail: filed.map((c) => `"${String(c.input.title ?? "").slice(0, 80)}"`).join(", ") + ". One ticket should have one item; the later ones were probably not needed.",
        runIds: filed.map((c) => c.run.id),
      });
    }

    // Repeats, not volume: a developer and Jetta trading answers is the bridge
    // working (14591 had 3 good posts in one day). Posting the same thing again
    // is the failure: overlapping runs, a comment answered twice, a re-chase.
    const posts = sorted.filter(postedToDevs);
    for (let i = 0; i < posts.length; i++) {
      const a = postText(posts[i]);
      const twin = posts.slice(i + 1).find((b) => at(b) - at(posts[i]) <= DAY && (a === "" ? postText(b) === "" : replySimilarity(a, postText(b)) >= REPEAT));
      if (twin) {
        findings.push({
          key: `repeated_dev_post:${ticketId}:${posts[i].run.id}`,
          rule: "repeated_dev_post",
          severity: "warn",
          ticketId,
          at: at(twin),
          title: `Jetta posted the same thing twice to developers on ticket ${ticketId}`,
          detail: `${Math.round((at(twin) - at(posts[i])) / 60_000)} min apart: "${(a || `(${posts[i].tool} ${String(posts[i].input.kind ?? "")})`).slice(0, 140)}". Each post notifies a developer.`,
          runIds: [...new Set([posts[i].run.id, twin.run.id])],
        });
        break;
      }
    }

    const firstEscalation = sorted.find(escalation);
    const close = firstEscalation ? sorted.find((c) => closedTicket(c) && at(c) >= at(firstEscalation)) : undefined;
    if (close) {
      findings.push({
        key: `closed_while_escalated:${ticketId}`,
        rule: "closed_while_escalated",
        severity: "bad",
        ticketId,
        at: at(close),
        title: `Ticket ${ticketId} closed after it was escalated`,
        detail: `Escalated (${firstEscalation!.tool}) and then closed by Jetta. Check the dev item is done or the customer confirmed it is solved.`,
        runIds: [...new Set([firstEscalation!.run.id, close.run.id])],
      });
    }

    for (const c of sorted.filter((x) => x.tool === "create_dev_item" && filedNew(x))) {
      const repro = String(c.input.repro_steps ?? "").trim();
      if (repro.length < 40 || /^(n\/?a|none|unknown|not provided|not specified)\b/i.test(repro)) {
        findings.push({
          key: `thin_dev_item:${c.run.id}`,
          rule: "thin_dev_item",
          severity: "warn",
          ticketId,
          at: at(c),
          title: `Dev item "${String(c.input.title ?? "").slice(0, 70)}" has no real repro steps`,
          detail: `Repro steps: "${repro.slice(0, 120) || "(empty)"}". A developer has to go back to support before starting.`,
          runIds: [c.run.id],
        });
      }
    }

    for (const c of sorted.filter(writeFailed)) {
      findings.push({
        key: `dev_write_failed:${c.run.id}:${c.tool}`,
        rule: "dev_write_failed",
        severity: "warn",
        ticketId,
        at: at(c),
        title: `${c.tool} did not land on ticket ${ticketId}`,
        detail: c.result.slice(0, 200),
        runIds: [c.run.id],
      });
    }

    for (const c of sorted.filter((x) => x.tool === "cancel_subscription" && x.result.startsWith("Subscription cancelled"))) {
      findings.push({
        key: `cancelled_subscription:${c.run.id}`,
        rule: "cancelled_subscription",
        severity: "bad",
        ticketId,
        at: at(c),
        title: `Jetta cancelled a subscription on ticket ${ticketId}`,
        detail: `Policy: only on the customer's explicit instruction. Check the ticket. Result: ${c.result.slice(0, 160)}`,
        runIds: [c.run.id],
      });
    }
  }

  const count = (f: (c: Call) => boolean) => calls.filter(f).length;
  return {
    days: WINDOW_DAYS,
    counts: {
      devItemsFiled: count((c) => c.tool === "create_dev_item" && filedNew(c)),
      devQuestions: count((c) => c.tool === "ask_devs" && filedNew(c)),
      dedupedOntoExisting: count((c) => (c.tool === "create_dev_item" || c.tool === "ask_devs") && /ALREADY has/.test(c.result)),
      devPosts: count(postedToDevs),
      escalations: count((c) => c.tool === "send_escalation"),
      compliance: count((c) => c.tool === "send_to_compliance" && /^Filed compliance/.test(c.result)),
      closes: count(closedTicket),
      billing: count((c) => ["apply_discount", "apply_monday_discount", "extend_trial", "cancel_subscription"].includes(c.tool)),
    },
    findings: findings.sort((a, b) => (a.severity === b.severity ? b.at - a.at : a.severity === "bad" ? -1 : 1)),
  };
}
