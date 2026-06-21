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
import * as freshdesk from "@/lib/tools/freshdesk";
import * as fastspring from "@/lib/tools/fastspring";
import * as monday from "@/lib/tools/monday";
import { replyInThread } from "@/lib/tools/slack";

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

  // extend trial for <email> <N> days
  m = cmd.match(/^extend trial for (\S+@\S+)\s+(\d+)\s*days?/i);
  if (m) {
    if (!isAdmin(userId)) {
      console.warn(`Rejected extend_trial from non-admin Slack user ${userId}`);
      await reply(":no_entry: You're not authorised to run that command.");
      return;
    }
    const r = await monday.extendTrial(m[1], Number(m[2]));
    await reply(`:white_check_mark: Trial for ${m[1]} extended to ${r.newTrialEndDate}.`);
    return;
  }

  // apply discount <coupon> to <email>
  m = cmd.match(/^apply discount (\S+) to (\S+@\S+)/i);
  if (m) {
    if (!isAdmin(userId)) {
      console.warn(`Rejected apply_discount from non-admin Slack user ${userId}`);
      await reply(":no_entry: You're not authorised to run that command.");
      return;
    }
    const account = await fastspring.getFastSpringAccount(m[2]);
    if (!account.found || !account.accountId) {
      await reply(`No FastSpring account found for ${m[2]}.`);
      return;
    }
    const r = await fastspring.applyDiscount(account.accountId, m[1]);
    await reply(`:white_check_mark: Discount ${m[1]} applied to ${m[2]}. New price ${r.newPrice}, effective ${r.effectiveDate}.`);
    return;
  }

  // cancel account <email>  → requires a second admin to confirm
  m = cmd.match(/^cancel account (\S+@\S+)/i);
  if (m) {
    if (!isAdmin(userId)) {
      console.warn(`Rejected cancel_account from non-admin Slack user ${userId}`);
      await reply(":no_entry: You're not authorised to run that command.");
      return;
    }
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
    const account = await fastspring.getFastSpringAccount(m[1]);
    if (!account.found || !account.accountId) {
      await reply(`No FastSpring account found for ${m[1]}.`);
      await kvDel(key);
      return;
    }
    const r = await fastspring.cancelSubscription(account.accountId);
    await kvDel(key);
    await reply(`:white_check_mark: Subscription for ${m[1]} cancelled. Access ends ${r.accessEndsDate}.`);
    return;
  }

  await reply(
    "I didn't recognise that command. Try: `status ticket #123`, `open tickets`, " +
      "`extend trial for user@example.com 7 days`, `apply discount CODE to user@example.com`, " +
      "or `cancel account user@example.com`.",
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
      handleCommand(cmd, userId, channel, threadTs).catch((err) =>
        console.error("Slack command failed:", err),
      );
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true });
}
