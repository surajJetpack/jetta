/**
 * Slack admin interface. The team mentions @Jetta in the designated channel to
 * query and instruct her.
 *
 * Supported commands (after the @Jetta mention):
 *   status ticket #12345
 *   open tickets
 *   extend trial for user@example.com 7 days
 *   apply discount COUPON to user@example.com
 *   cancel account user@example.com          (requires a 2nd admin to confirm)
 *   confirm cancel user@example.com          (the 2nd-admin confirmation)
 *
 * Admin-gated commands (extend / discount / cancel) require the Slack user to be
 * in ADMIN_SLACK_USER_IDS. Rejected attempts are logged.
 */
import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { config } from "@/lib/config";
import { kvSet, kvGet, kvDel } from "@/lib/kv";
import { resolveMonetApproval } from "@/lib/monetization-approvals";
import { getArticle, createArticle, updateArticle, transitionState } from "@/lib/kb-store";
import * as freshdesk from "@/lib/tools/freshdesk";
import * as fastspring from "@/lib/tools/fastspring";
import * as mondayMonetization from "@/lib/tools/monday-monetization";
import type { AppProduct } from "@/lib/types";
import { replyInThread, readThread } from "@/lib/tools/slack";
import { draftKbArticle } from "@/lib/knowledge-loop";
import { logOpsEvent } from "@/lib/events";

/** Audit trail for privileged Slack commands and their rejections. */
async function logSlackEvent(
  level: "info" | "warn",
  event: string,
  userId: string,
  data?: Record<string, unknown>,
): Promise<void> {
  await logOpsEvent({ level, event, source: "slack", actor: userId, data });
}

export const runtime = "nodejs";

function verifySlackSignature(raw: string, req: NextRequest): boolean {
  const secret = config.slack.signingSecret;
  if (!secret) return true; // stub / local
  const ts = req.headers.get("x-slack-request-timestamp");
  const sig = req.headers.get("x-slack-signature");
  if (!ts || !sig) return false;
  // Reject requests older than 5 minutes (replay protection).
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const base = `v0:${ts}:${raw}`;
  const expected = `v0=${crypto.createHmac("sha256", secret).update(base).digest("hex")}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch {
    return false;
  }
}

const isAdmin = (userId: string) => config.slack.adminUserIds.includes(userId);

/** Strip the leading "<@BOTID>" mention and normalise whitespace. */
function parseCommand(text: string): string {
  return text.replace(/<@[^>]+>/g, "").trim().replace(/\s+/g, " ");
}

async function handleCommand(
  cmd: string,
  userId: string,
  channel: string,
  threadTs: string,
): Promise<void> {
  const reply = (text: string) => replyInThread(channel, threadTs, text);

  // status ticket #12345
  let m = cmd.match(/^status ticket #?(\d+)/i);
  if (m) {
    const ticket = await freshdesk.getTicketDetails(m[1]);
    const last = ticket.replies.filter((r) => !r.isPrivate).at(-1);
    await reply(
      `*Ticket #${ticket.id}* — status *${ticket.status}*\n` +
        `Subject: ${ticket.subject}\n` +
        `Last message: ${(last?.body ?? ticket.description).slice(0, 200)}`,
    );
    return;
  }

  // open tickets
  if (/^open tickets/i.test(cmd)) {
    const s = await freshdesk.listOpenTickets();
    const overdue = s.overdue48h.length
      ? s.overdue48h.map((t) => `  • #${t.id} (${t.ageHours}h): ${t.subject}`).join("\n")
      : "  none";
    await reply(
      `*Open tickets:* ${s.count}\n` +
        `Oldest: ${s.oldestAgeHours ?? "—"}h\n` +
        `Unresolved >48h:\n${overdue}`,
    );
    return;
  }

  // extend monday trial <app> <account-url-or-slug> <N> days
  // (monday's mutation is keyed by account slug + app, so both are required.)
  m = cmd.match(/^extend monday trial (\S+) (\S+)\s+(\d+)\s*days?/i);
  if (m) {
    if (!isAdmin(userId)) {
      console.warn(`Rejected extend_trial from non-admin Slack user ${userId}`);
      await logSlackEvent("warn", "slack.command_rejected", userId, { action: "extend_trial" });
      await reply(":no_entry: You're not authorised to run that command.");
      return;
    }
    const app = m[1].toLowerCase() as AppProduct;
    const slug = mondayMonetization.parseAccountSlug(m[2]);
    if (!config.monday.monetization.stores[app]?.appId) {
      await reply(`:warning: No monday monetization config for app "${m[1]}". Configured apps: ${Object.keys(config.monday.monetization.stores).join(", ") || "(none)"}.`);
      return;
    }
    if (!slug) { await reply(`:warning: "${m[2]}" isn't a monday account URL or slug.`); return; }
    const r = await mondayMonetization.extendTrial(app, slug, Number(m[3]));
    await logSlackEvent("info", "slack.privileged_action", userId, { action: "extend_trial", app, slug, days: Number(m[3]) });
    await reply(r.success
      ? `:white_check_mark: Trial for *${slug}* (${app}) set to ${m[3]} days.`
      : `:x: monday declined the trial extension for *${slug}*: ${r.reason || "no reason given"}.`);
    return;
  }

  // apply monday discount <app> <account> <percent> <days> <monthly|yearly>
  m = cmd.match(/^apply monday discount (\S+) (\S+)\s+(\d+)\s+(\d+)\s+(monthly|yearly)/i);
  if (m) {
    if (!isAdmin(userId)) {
      await logSlackEvent("warn", "slack.command_rejected", userId, { action: "apply_monday_discount" });
      await reply(":no_entry: You're not authorised to run that command.");
      return;
    }
    const app = m[1].toLowerCase() as AppProduct;
    const slug = mondayMonetization.parseAccountSlug(m[2]);
    if (!config.monday.monetization.stores[app]?.appId) {
      await reply(`:warning: No monday monetization config for app "${m[1]}". Configured apps: ${Object.keys(config.monday.monetization.stores).join(", ") || "(none)"}.`);
      return;
    }
    if (!slug) { await reply(`:warning: "${m[2]}" isn't a monday account URL or slug.`); return; }
    const r = await mondayMonetization.applyDiscount(app, slug, {
      percent: Number(m[3]), daysValid: Number(m[4]), period: m[5].toUpperCase() as "MONTHLY" | "YEARLY",
    });
    await logSlackEvent("info", "slack.privileged_action", userId, { action: "apply_monday_discount", app, slug, percent: Number(m[3]) });
    await reply(r.applied
      ? `:white_check_mark: Discount applied to *${slug}* (${app}): ${r.detail}.`
      : `:x: Discount NOT applied to *${slug}*: ${r.detail}.`);
    return;
  }

  // approve / reject monet <ref> — decide a trial/discount request Jetta made
  m = cmd.match(/^(approve|reject) monet (\w+)/i);
  if (m) {
    const decision = m[1].toLowerCase() as "approve" | "reject";
    if (!isAdmin(userId)) {
      await logSlackEvent("warn", "slack.command_rejected", userId, { action: `${decision}_monet` });
      await reply(":no_entry: You're not authorised to decide monetization actions.");
      return;
    }
    const res = await resolveMonetApproval(m[2], decision, `slack:${userId}`);
    await logSlackEvent("info", "slack.privileged_action", userId, { action: `${decision}_monet`, ref: m[2], ok: res.ok });
    const icon = !res.found ? ":grey_question:" : decision === "reject" ? ":wastebasket:" : res.ok ? ":white_check_mark:" : ":x:";
    await reply(`${icon} ${res.message}`);
    return;
  }

  // apply discount <coupon> to <email>
  m = cmd.match(/^apply discount (\S+) to (\S+@\S+)/i);
  if (m) {
    if (!isAdmin(userId)) {
      console.warn(`Rejected apply_discount from non-admin Slack user ${userId}`);
      await logSlackEvent("warn", "slack.command_rejected", userId, { action: "apply_discount" });
      await reply(":no_entry: You're not authorised to run that command.");
      return;
    }
    const found = await fastspring.findAccountAcrossStores(m[2]);
    if (!found?.account.subscriptionId) {
      await reply(`No FastSpring subscription found for ${m[2]}.`);
      return;
    }
    const r = await fastspring.applyDiscount(found.account.subscriptionId, m[1], found.appProduct);
    await logSlackEvent("info", "slack.privileged_action", userId, { action: "apply_discount", coupon: m[1], email: m[2] });
    await reply(`:white_check_mark: Discount ${m[1]} applied to ${m[2]}. New price ${r.newPrice}, effective ${r.effectiveDate}.`);
    return;
  }

  // cancel account <email>  → requires a second admin to confirm
  m = cmd.match(/^cancel account (\S+@\S+)/i);
  if (m) {
    if (!isAdmin(userId)) {
      console.warn(`Rejected cancel_account from non-admin Slack user ${userId}`);
      await logSlackEvent("warn", "slack.command_rejected", userId, { action: "cancel_account" });
      await reply(":no_entry: You're not authorised to run that command.");
      return;
    }
    await logSlackEvent("info", "slack.privileged_action", userId, { action: "cancel_account_requested", email: m[1] });
    await kvSet(`jetta:cancel-pending:${m[1].toLowerCase()}`, userId, 600);
    await reply(
      `:warning: Cancellation of *${m[1]}* requested by <@${userId}>. ` +
        `A *different* admin must confirm within 10 minutes:\n` +
        `\`@Jetta confirm cancel ${m[1]}\``,
    );
    return;
  }

  // confirm cancel <email>  → the second admin
  m = cmd.match(/^confirm cancel (\S+@\S+)/i);
  if (m) {
    if (!isAdmin(userId)) {
      await reply(":no_entry: You're not authorised to confirm cancellations.");
      return;
    }
    const key = `jetta:cancel-pending:${m[1].toLowerCase()}`;
    const requester = await kvGet(key);
    if (!requester) {
      await reply(`No pending cancellation for ${m[1]} (it may have expired).`);
      return;
    }
    if (requester === userId) {
      await reply(":no_entry: The confirmation must come from a *different* admin than the requester.");
      return;
    }
    const found = await fastspring.findAccountAcrossStores(m[1]);
    if (!found?.account.subscriptionId) {
      await reply(`No FastSpring subscription found for ${m[1]}.`);
      await kvDel(key);
      return;
    }
    const r = await fastspring.cancelSubscription(found.account.subscriptionId, found.appProduct);
    await kvDel(key);
    await logSlackEvent("info", "slack.privileged_action", userId, { action: "cancel_account_confirmed", email: m[1], requestedBy: requester });
    await reply(`:white_check_mark: Subscription for ${m[1]} cancelled. Access ends ${r.accessEndsDate}.`);
    return;
  }

  // ── Knowledge Loop ──
  // draft kb — read the escalation thread and draft an article for review
  if (/^draft kb/i.test(cmd)) {
    if (!threadTs) {
      await reply("Run `@Jetta draft kb` inside an escalation thread that has the dev's resolution.");
      return;
    }
    const msgs = await readThread(channel, threadTs);
    const threadText = msgs
      .map((m) => `${m.isBot ? "Jetta/bot" : "team"}: ${m.text}`)
      .join("\n\n")
      .trim();
    if (!threadText) {
      await reply("I couldn't read this thread — the bot may be missing the `channels:history` scope, or the thread is empty.");
      return;
    }
    const draft = await draftKbArticle(threadText);
    // Draft article id = thread ts, so `publish kb` in the same thread finds it.
    const existing = await getArticle(threadTs);
    if (existing && existing.state === "draft") {
      await updateArticle(
        threadTs,
        { title: draft.title, body: draft.body, keywords: draft.keywords },
        `slack:${userId}`,
      );
    } else if (!existing) {
      await createArticle({
        id: threadTs,
        title: draft.title,
        body: draft.body,
        keywords: draft.keywords,
        category: "support-learned",
        state: "draft",
        origin: "knowledge-loop",
        createdBy: `slack:${userId}`,
        meta: { channel, threadTs },
      });
    } else {
      await reply(`This thread's draft was already published as *${existing.title}* — edit it in the console KB tab instead.`);
      return;
    }
    await reply(
      [
        ":memo: *Draft KB article* — review before publishing:",
        `*Title:* ${draft.title}`,
        "",
        draft.body,
        "",
        `_Keywords:_ ${draft.keywords.join(", ")}`,
        "",
        "An admin can add it to Jetta's knowledge base with `@Jetta publish kb` (in this thread).",
      ].join("\n"),
    );
    return;
  }

  // publish kb — admin approves the drafted article into the live KB
  if (/^publish kb/i.test(cmd)) {
    if (!isAdmin(userId)) {
      console.warn(`Rejected publish kb from non-admin Slack user ${userId}`);
      await logSlackEvent("warn", "slack.command_rejected", userId, { action: "publish_kb" });
      await reply(":no_entry: Only an admin can publish to the knowledge base.");
      return;
    }
    if (!threadTs) {
      await reply("Run `@Jetta publish kb` in the thread that has the draft.");
      return;
    }
    const draft = await getArticle(threadTs);
    if (!draft) {
      await reply("No draft found in this thread. Run `@Jetta draft kb` first.");
      return;
    }
    if (draft.state === "published") {
      await reply(`Already published: *${draft.title}*.`);
      return;
    }
    // Publish = lifecycle transition on the same article; the store embeds it
    // into the vector index and records the audit event.
    try {
      await transitionState(threadTs, "published", `slack:${userId}`);
    } catch (e) {
      await reply(`:warning: Couldn't publish: ${e instanceof Error ? e.message : "unknown error"}`);
      return;
    }
    await reply(`:white_check_mark: Added to Jetta's knowledge base: *${draft.title}*. She'll use it on matching tickets from now on.`);
    return;
  }

  await reply(
    "I didn't recognise that command. Try: `status ticket #123`, `open tickets`, " +
      "`extend trial for user@example.com 7 days`, `apply discount CODE to user@example.com`, " +
      "`cancel account user@example.com`, or in an escalation thread `draft kb` / `publish kb`.",
  );
}

export async function POST(req: NextRequest) {
  const raw = await req.text();

  if (!verifySlackSignature(raw, req)) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  // Slack URL verification handshake.
  if (body.type === "url_verification") {
    return NextResponse.json({ challenge: body.challenge });
  }

  // Event callback (app_mention).
  if (body.type === "event_callback") {
    const event = body.event as Record<string, unknown> | undefined;
    if (event?.type === "app_mention" && !event.bot_id) {
      const cmd = parseCommand(String(event.text ?? ""));
      const userId = String(event.user ?? "");
      const channel = String(event.channel ?? "");
      const threadTs = String(event.thread_ts ?? event.ts ?? "");
      // Handle async so we can ack Slack within 3s.
      handleCommand(cmd, userId, channel, threadTs).catch(async (err) => {
        console.error("Slack command failed:", err);
        await logOpsEvent({
          level: "error",
          event: "slack.command_failed",
          source: "slack",
          actor: userId,
          data: { cmd: cmd.slice(0, 120), error: err instanceof Error ? err.message : String(err) },
        });
      });
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true });
}
