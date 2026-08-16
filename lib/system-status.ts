/**
 * What Jetta can actually do right now, derived from config in one place.
 *
 * The console used to render five boolean badges — "Freshdesk LIVE",
 * "monday.com LIVE" — and that turned out to be the wrong question. A badge
 * that says LIVE cannot distinguish reading a board from writing to it, cannot
 * tell you that a channel is switched on but has no credentials behind it, and
 * says nothing at all about the switches that decide which tickets Jetta is
 * allowed to touch. Three of those were invisible from the console entirely:
 * the write gates, the rollout filters, and the fact that the chat channel
 * answering customers unsupervised was missing from the list while a retired
 * one sat at the top of it.
 *
 * So every row here carries three things instead of one: a state, a plain
 * sentence about what that means for a customer, and the setting to change if
 * it's wrong. The sentence is the point — a flag dump is not a status page.
 *
 * Read-only and pure: this derives from `config` and never calls out. Live
 * reachability checks that need a network round-trip (can Jetta post in this
 * Slack channel?) live in their own components.
 */
import { config } from "./config";
import { modelLabel } from "./llm";
import type { Product } from "./types";

/**
 * Every value `Product` can take. A Record rather than an array so adding a
 * product breaks the build here — the point of this map is deciding whether a
 * filter listing every product is really a filter at all, and it can only
 * answer that if it knows the full set.
 */
const ALL_PRODUCTS: Record<Product, true> = { jetpackapps: true, getsign: true, unknown: true };

/**
 * Four states, because two aren't enough.
 *  on   — active, and things happen in the outside world
 *  good — a protective gate is engaged (draft mode, intake filtering)
 *  off  — inactive or simulated; nothing escapes
 *  warn — switched on but not actually able to work, or working with no
 *         human check. The only tone that means "look at this".
 */
export type SignalTone = "on" | "good" | "off" | "warn";

export interface StatusRow {
  /** Named for what it does, not what the variable is called. */
  label: string;
  tone: SignalTone;
  /** The state word in the chip: LIVE / DRY RUN / DRAFT … */
  state: string;
  /** One sentence on what this means in practice. */
  meaning: string;
  /** The environment variable behind it, so an admin knows what to change. */
  setting?: string;
}

/** How customers and colleagues actually reach Jetta. */
export function channelRows(): StatusRow[] {
  const rows: StatusRow[] = [];

  const fd = config.freshdesk;
  const fdReady = !!(fd.apiKey && fd.domain);
  rows.push({
    label: "Freshdesk — email tickets",
    tone: !fd.live ? "off" : fdReady ? "on" : "warn",
    state: !fd.live ? "STUBBED" : fdReady ? "LIVE" : "NO CREDENTIALS",
    meaning: !fd.live
      ? "Ticket tools return canned data. Nothing reaches a real ticket."
      : fdReady
        ? `Connected to ${fd.domain}. ${
            config.replyMode === "auto"
              ? "Replies go straight to the customer."
              : "Every reply waits for a human."
          }`
        : "Switched on, but FRESHDESK_API_KEY or FRESHDESK_DOMAIN is missing — every call will fail.",
    setting: "FRESHDESK_LIVE",
  });

  const jc = config.jettachat;
  const origins = jc.allowedOrigins.length;
  rows.push({
    label: "JettaChat — website & in-app chat",
    tone: !jc.live ? "off" : jc.secret ? "on" : "warn",
    state: !jc.live ? "OFF" : jc.secret ? "LIVE" : "NO SECRET",
    meaning: !jc.live
      ? "The public chat endpoints refuse traffic."
      : jc.secret
        ? `Jetta answers visitors directly, with nobody reading first. ${
            origins ? `${origins} embedding origin${origins === 1 ? "" : "s"} allowed` : "Same-origin embedding only"
          }${config.blob.token ? "" : "; attachments are refused (no blob token)"}.`
        : "Switched on, but JETTACHAT_SECRET is unset — the channel refuses to serve.",
    setting: "JETTACHAT_LIVE",
  });

  const sl = config.slack;
  const routed = [
    sl.escalationChannel,
    sl.chatChannel,
    sl.opsChannel,
    sl.draftsChannel,
    sl.partnershipsChannel,
  ].filter(Boolean).length;
  rows.push({
    label: "Slack — escalations, approvals, DMs",
    tone: !sl.live ? "off" : sl.botToken ? "on" : "warn",
    state: !sl.live ? "STUBBED" : sl.botToken ? "LIVE" : "NO TOKEN",
    meaning: !sl.live
      ? "Escalations and approval requests are logged, not posted."
      : sl.botToken
        ? `${routed} channel${routed === 1 ? "" : "s"} routed. Colleagues can also message Jetta directly — she is read-only in DMs.`
        : "Switched on, but SLACK_BOT_TOKEN is missing — nothing can be posted.",
    setting: "SLACK_LIVE",
  });

  // Kept visible rather than deleted: the handler still exists and would run
  // the agent if Freshchat were pointed at it, so silently dropping it from
  // the console would hide a live code path rather than retire it.
  const fc = config.freshchat;
  const fcReady = !!(fc.apiToken && fc.webhookPublicKey && fc.handoffGroupId);
  rows.push({
    label: "Freshchat — superseded by JettaChat",
    tone: fc.live && fcReady ? "warn" : "off",
    state: !fc.live ? "RETIRED" : fcReady ? "STILL ON" : "INCOMPLETE",
    meaning: !fc.live
      ? "Replaced by JettaChat. The hand-off handler still exists but nothing is pointed at it."
      : fcReady
        ? "Switched on alongside JettaChat — two chat channels are live at once, which is probably not intended."
        : "Switched on but missing its API token, webhook key or hand-off group, so no event will ever be accepted.",
    setting: "FRESHCHAT_LIVE",
  });

  return rows;
}

/**
 * What Jetta may change in the outside world. Every one of these is an
 * explicit opt-in that is independent of the LIVE flags above — an integration
 * can be fully live and still unable to write.
 */
export function capabilityRows(): StatusRow[] {
  const auto = config.replyMode === "auto";
  return [
    {
      label: "Reply to customers",
      tone: auto ? "warn" : "good",
      state: auto ? "AUTO" : "DRAFT",
      meaning: auto
        ? "Replies reach the customer with no human in front of them."
        : "Jetta proposes and a human sends. The suggestion is posted as a private note on the ticket.",
      setting: "JETTA_REPLY_MODE",
    },
    {
      label: "Write to the monday dev boards",
      tone: config.monday.allowWrites ? "on" : "off",
      state: config.monday.allowWrites ? "ARMED" : "DRY RUN",
      meaning: config.monday.allowWrites
        ? "Creating items and posting +1 updates happens for real, with no approval step."
        : "Board searches work; every write is simulated.",
      setting: "MONDAY_ALLOW_WRITES",
    },
    {
      label: "FastSpring discounts & cancellations",
      tone: config.fastspring.allowWrites ? "on" : "off",
      state: config.fastspring.allowWrites ? "ARMED" : "DRY RUN",
      meaning: config.fastspring.allowWrites
        ? "Discounts and cancellations touch real subscriptions, including from Slack commands."
        : "Account and invoice reads work; nothing can be charged, discounted or cancelled.",
      setting: "FASTSPRING_ALLOW_WRITES",
    },
    {
      label: "monday trials & discounts",
      tone: config.monday.monetization.allowWrites ? "on" : "off",
      state: config.monday.monetization.allowWrites ? "ARMED" : "DRY RUN",
      meaning: config.monday.monetization.allowWrites
        ? "Approved trial extensions and discounts are applied to real accounts."
        : "Requests are still filed for a human, but approving one changes nothing yet.",
      setting: "MONDAY_MONETIZATION_ALLOW_WRITES",
    },
  ];
}

/**
 * Which tickets Jetta is allowed to touch at all. These decide whether a run
 * happens — a ticket filtered out here produces no draft, no note and no
 * event, which from the outside is indistinguishable from Jetta ignoring it.
 */
export function rolloutRows(): StatusRow[] {
  const products = config.productFilter;
  const allowlist = config.ticketAllowlist;
  // What the filter actually keeps out, rather than what it happens to list.
  const excluded = products.length
    ? (Object.keys(ALL_PRODUCTS) as Product[]).filter((p) => !products.includes(p))
    : [];
  return [
    {
      label: "Intake filter",
      tone: config.intakeFilter ? "good" : "off",
      state: config.intakeFilter ? "ON" : "OFF",
      meaning: config.intakeFilter
        ? "Out-of-office replies, bounces, marketing and spam are skipped before the agent runs."
        : "Every inbound email is drafted for, including auto-replies and marketing.",
      setting: "JETTA_INTAKE_FILTER",
    },
    {
      // A filter naming every product excludes nothing. Reporting that as a
      // restriction — and painting it amber — would have someone hunting for
      // tickets being dropped when none are.
      label: "Product filter",
      tone: excluded.length ? "warn" : "off",
      state: excluded.length ? products.join(", ").toUpperCase() : "ALL PRODUCTS",
      meaning: excluded.length
        ? `Email and Freshchat intake is skipped for ${excluded.join(" and ")} — those tickets get no suggestion and no note. Chat conversations are not filtered.`
        : products.length
          ? "Set, but it names every product, so nothing is excluded — the same as leaving it unset."
          : "No product is filtered out.",
      setting: "JETTA_PRODUCTS",
    },
    {
      /*
       * Two things make this row hard to state honestly, and both were wrong
       * here before.
       *
       * It never gates chat: liveWritesAllowed() returns true for jettachat
       * before it reads the list at all.
       *
       * And in DRAFT mode it gates nothing whatsoever. runAgentLoop computes
       * `dryRun = opts.dryRun || (!allowed && !hold)` — draft mode sets hold,
       * so a non-allowlisted ticket is never forced dry. Customer writes are
       * already held and the internal actions are meant to run for every
       * ticket. An allowlist therefore sits inert until reply mode flips to
       * AUTO, at which point it silently becomes a hard restriction. Reporting
       * it as an active brake while it does nothing is the wrong error; so is
       * hiding a landmine that arms itself on a config change.
       */
      label: "Ticket allowlist",
      tone: allowlist.length ? "warn" : "off",
      state: !allowlist.length
        ? "NO RESTRICTION"
        : `${allowlist.length} TICKET${allowlist.length === 1 ? "" : "S"}${
            config.replyMode === "draft" ? " · INERT" : ""
          }`,
      meaning: !allowlist.length
        ? "Jetta may write on any ticket that passes the filters above."
        : config.replyMode === "draft"
          ? `Lists ${allowlist.join(", ")}, but restricts nothing while reply mode is DRAFT — held runs are never forced dry, so every ticket still gets its private note, Slack escalation and dev-board item. Switch reply mode to AUTO and this becomes a hard limit to those ids alone, with nothing on screen to announce it. It never gates chat.`
          : `Live writes only happen on ${allowlist.join(", ")} — every other ticket reasons and writes nothing. It does NOT gate chat: JettaChat conversations write, reply and raise tickets as normal.`,
      setting: "JETTA_TICKET_ALLOWLIST",
    },
    {
      label: "Suggestion as a Freshdesk note",
      tone: config.draftNoteToFreshdesk ? "good" : "warn",
      state: config.draftNoteToFreshdesk ? "ON" : "OFF",
      meaning: config.draftNoteToFreshdesk
        ? "Every suggestion is posted as a private note on the ticket — the primary review surface."
        : "Suggestions exist only in the console, where nobody works them.",
      setting: "JETTA_DRAFT_FD_NOTE",
    },
  ];
}

/** Which models answer, and how the knowledge base is searched. */
export function reasoningRows(): StatusRow[] {
  const v = config.vector;
  const vectorOn = !!(v.url && v.token);
  return [
    {
      label: "Standard tier — customer-facing runs",
      tone: "on",
      state: modelLabel("standard"),
      meaning: "Answers tickets, chats and Slack questions.",
      setting: "LLM_PROVIDER",
    },
    {
      label: "Light tier — triage, reranking, small talk",
      tone: "on",
      state: modelLabel("light"),
      meaning: "Quality-insensitive calls, at a fraction of the cost.",
    },
    {
      label: "Complexity routing",
      tone: config.llm.tieredAgent ? "on" : "off",
      state: config.llm.tieredAgent ? "ON" : "OFF",
      meaning: config.llm.tieredAgent
        ? "Tickets triaged as simple are answered on the light tier."
        : "Every customer-facing run uses the standard tier, whatever its complexity.",
      setting: "JETTA_TIERED_AGENT",
    },
    {
      label: "Knowledge retrieval",
      tone: vectorOn ? "on" : "warn",
      state: !vectorOn ? "KEYWORD ONLY" : v.hybrid ? "HYBRID INDEX" : "DENSE INDEX",
      meaning: !vectorOn
        ? "No vector index configured — search falls back to keyword matching over published articles."
        : v.hybrid
          ? "Upstash embeds server-side and blends semantic with BM25 keyword scoring."
          : `Client-side embedding with ${v.embedModel} at ${v.dimension} dimensions.`,
      setting: "UPSTASH_VECTOR_HYBRID",
    },
    {
      label: "Reranking",
      tone: config.rerank.enabled ? "on" : "off",
      state: config.rerank.enabled ? "ON" : "OFF",
      meaning: config.rerank.enabled
        ? `Retrieved articles are re-scored by the light tier, with a ${config.rerank.timeoutMs}ms budget.`
        : "Retrieval order is whatever the index returned.",
      setting: "RERANK_ENABLED",
    },
    {
      // Not driven by a flag — it's a property of the code paths, and the
      // asymmetry is the whole point. A chat screenshot becomes words the model
      // can read; the identical screenshot on an email ticket does not, and
      // nothing in the reply says so. That silence is why this is a warn.
      label: "Reading images",
      tone: "warn",
      state: "CHAT ONLY",
      meaning:
        "Images a visitor uploads in chat get a light-tier vision pass — errors transcribed verbatim — and the description stays in the prompt for the rest of the conversation. PDFs are skipped. Freshdesk attachments get none of this: the model is never told a file is there, and answers the ticket without it. Slack DMs likewise see only a filename.",
    },
  ];
}

/**
 * The one or two facts worth carrying on every screen.
 *
 * Not a summary of the System page — a filter for the things that would
 * surprise someone who didn't go looking. Reply mode always qualifies: whether
 * a human sees a reply before the customer does is the premise of everybody's
 * job here. A rollout filter qualifies because it makes Jetta look broken
 * (tickets arrive, nothing happens) with no other visible explanation.
 *
 * Write gates deliberately do NOT appear. MONDAY_ALLOW_WRITES is armed as the
 * intended steady state, and a permanent warning about the intended steady
 * state is how people learn to stop reading warnings.
 */
export function headlineState(): StatusRow[] {
  const rows: StatusRow[] = [];
  const auto = config.replyMode === "auto";
  rows.push({
    label: "Reply mode",
    tone: auto ? "warn" : "good",
    state: auto ? "AUTO" : "DRAFT",
    meaning: auto
      ? "Replies reach the customer with no human in front of them."
      : "Every Freshdesk reply waits for a human.",
  });

  const allowlist = config.ticketAllowlist;
  const products = config.productFilter;
  if (allowlist.length) {
    rows.push({
      label: "Ticket allowlist",
      tone: "warn",
      state: `${allowlist.length} TICKET${allowlist.length === 1 ? "" : "S"}${
        config.replyMode === "draft" ? " · INERT" : ""
      }`,
      meaning:
        config.replyMode === "draft"
          ? `Lists ${allowlist.join(", ")} but restricts nothing in DRAFT mode. It becomes a hard limit the moment reply mode flips to AUTO.`
          : `On tickets Jetta only writes on ${allowlist.join(", ")}; every other ticket reasons and writes nothing. Chat is not gated by it.`,
    });
    // Only a filter that actually excludes a product is worth a chip. One that
    // names all three restricts nothing, and a permanent amber badge for
    // nothing is how people learn to stop reading the bar.
  } else if (
    products.length &&
    (Object.keys(ALL_PRODUCTS) as Product[]).some((p) => !products.includes(p))
  ) {
    rows.push({
      label: "Product filter",
      tone: "warn",
      state: products.join(", ").toUpperCase(),
      meaning:
        "Email and Freshchat intake outside this list is skipped before the agent runs. Chat conversations are not filtered.",
    });
  }
  return rows;
}

export interface EndpointRow {
  path: string;
  detail: string;
  /** Human-readable cron schedule, for the scheduled jobs. */
  schedule?: string;
}

/** Everything that can start a run. Kept beside vercel.json's cron block. */
export const ENDPOINTS: readonly EndpointRow[] = [
  { path: "POST /api/webhook", detail: "Freshdesk ticket and reply events — the production entrypoint" },
  { path: "POST /api/webhook/agent-reply", detail: "Reconciles a suggestion against what the agent actually sent" },
  { path: "POST /api/webhook/freshchat", detail: "Freshchat hand-off — retired channel, handler still present" },
  { path: "POST /api/slack", detail: "Slack events: @Jetta commands, direct messages, the agent panel" },
  { path: "POST /api/chat/*", detail: "Public JettaChat API — session, message, stream, upload" },
  { path: "POST /api/admin/run", detail: "This console's ticket runner (admin only)" },
] as const;

export const CRONS: readonly EndpointRow[] = [
  { path: "/api/cron/followup", detail: "Checks tickets waiting 24h on a customer", schedule: "daily 09:00" },
  { path: "/api/cron/kb-sync", detail: "Re-crawls the sites into the knowledge base", schedule: "daily 05:00" },
  { path: "/api/cron/reconcile-drafts", detail: "Matches suggestions to what humans actually sent", schedule: "hourly at :15" },
  { path: "/api/cron/daily-overview", detail: "Yesterday's rollup and its written narrative", schedule: "daily 06:10" },
] as const;
