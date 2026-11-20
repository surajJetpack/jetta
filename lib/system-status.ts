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
import { lightReasoning, modelLabel } from "./llm";
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
  /**
   * Which card on /system explains this, for the topbar chips. Without it the
   * chip lands at the top of the page and leaves the reader to find the row —
   * and does visibly nothing at all when they are already on /system.
   */
  anchor?: string;
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
              : config.firstResponse === "on"
                ? "Jetta sends first replies on direct tickets; the rest wait for a human."
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
        ? `Jetta answers visitors directly, with nobody reading first. A monday account is trusted only with a signed session token, billing is never answered in chat, and new chats, tickets and team pings are capped. ${
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
      ? "Replaced by JettaChat. The hand-off handler still exists but nothing is pointed at it, and it refuses any request it cannot verify."
      : fcReady
        ? "Switched on alongside JettaChat — two chat channels are live at once, which is probably not intended."
        : "Switched on but missing its API token, webhook key or hand-off group, so no event will ever be accepted.",
    setting: "FRESHCHAT_LIVE",
  });

  // The console voice assistant. Read-only by construction, so "on" rather
  // than "warn" — but it does read customer tickets aloud to whoever asks, and
  // it sends them to Google to do it, which is worth seeing stated here.
  rows.push({
    label: "Console voice assistant",
    tone: config.google.apiKey ? "on" : "off",
    state: !config.google.apiKey ? "NO KEY" : config.consoleAssistantUsers.length ? `ADMINS + ${config.consoleAssistantUsers.length}` : "ADMINS",
    meaning: config.google.apiKey
      ? `Admins${config.consoleAssistantUsers.length ? ` and ${config.consoleAssistantUsers.join(", ")}` : ""} can talk to Jetta in the console (⌘J) on Gemini Live. Read-only: she looks things up and moves the page, and every lookup is logged as assistant.tool.`
      : "Needs GOOGLE_GENERATIVE_AI_API_KEY — the voice panel will refuse to start.",
    setting: "GOOGLE_GENERATIVE_AI_API_KEY",
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
      label: "First response on email tickets",
      tone: auto || config.firstResponse === "off" ? "off" : config.firstResponse === "on" ? "warn" : "good",
      state: auto ? "N/A" : config.firstResponse.toUpperCase(),
      meaning: auto
        ? "Reply mode is AUTO, so every reply already goes out."
        : config.firstResponse === "on"
          ? `Jetta sends the first reply herself on tickets that came in by email, the portal or the in-app form, ${config.firstResponseDelayMinutes.join("–")} minutes after writing it, if a second check passes. Never on tickets from a chat. Reply first or tag jetta-hold to stop one. Later replies are drafts.`
          : config.firstResponse === "shadow"
            ? "Shadow: drafts say whether Jetta would have sent them as the first response. Nothing reaches a customer."
            : "Off. The first reply is a draft like every other.",
      setting: "JETTA_FIRST_RESPONSE",
    },
    {
      label: "Ticket mirror reads",
      tone: !process.env.DATABASE_URL || config.ticketMirror === "off" ? "off" : "good",
      state: !process.env.DATABASE_URL ? "NO DATABASE" : config.ticketMirror.toUpperCase(),
      meaning: !process.env.DATABASE_URL
        ? "No ticket database is connected; everything reads Freshdesk directly."
        : config.ticketMirror === "off"
          ? "Off. Everything reads Freshdesk directly; the copy keeps filling but nothing uses it."
          : "Today, draft matching and the performance sync read Jetta's own copy of the tickets when it is up to date, saving Freshdesk API calls. Ticket replies still read Freshdesk.",
      setting: "JETTA_TICKET_MIRROR",
    },
    {
      label: "Write to the monday dev boards",
      tone: config.monday.allowWrites ? "on" : "off",
      state: config.monday.allowWrites ? "ARMED" : "DRY RUN",
      meaning: config.monday.allowWrites
        ? "Creating items and posting their context happens for real, with no approval step."
        : "Board searches work; nothing is filed or posted. Jetta is told so, and hands the ticket to a person through Slack instead of saying the team has it.",
      setting: "MONDAY_ALLOW_WRITES",
    },
    {
      label: "FastSpring discounts & cancellations",
      tone: config.fastspring.allowWrites ? "on" : "off",
      state: config.fastspring.allowWrites ? "ARMED" : "DRY RUN",
      meaning: config.fastspring.allowWrites
        ? "Discounts and cancellations touch real subscriptions, including from Slack commands."
        : "Account and invoice reads work on tickets; nothing can be charged, discounted or cancelled, and Jetta and the Slack commands say so. Billing is never looked up or changed from chat.",
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
 * The dev bridge: Freshdesk ⇄ monday dev boards, four separate switches,
 * each off / shadow / on. Shadow does everything except the write, and logs
 * what it would have written as a devbridge.* event (/events).
 */
export function devBridgeRows(): StatusRow[] {
  const row = (
    label: string,
    mode: "off" | "shadow" | "on",
    setting: string,
    on: string,
  ): StatusRow => ({
    label,
    tone: mode === "on" ? "on" : mode === "shadow" ? "good" : "off",
    state: mode.toUpperCase(),
    meaning:
      mode === "on"
        ? on
        : mode === "shadow"
          ? `Shadow: works out what it would do and logs it (devbridge.* events), posts nothing. When on: ${on}`
          : `Off. When on: ${on}`,
    setting,
  });
  return [
    row(
      "Developers → customer",
      config.devBridge,
      "JETTA_DEV_BRIDGE",
      'A developer\'s comment or Dev Status change on a ticket\'s dev item starts a ticket run: Jetta answers the developer on the item ("🤖 Jetta:", @mentioning whoever wrote; a comment that @mentions a colleague is a hand-off she does not answer on the item), asks the customer for what the developer needs, or tells the customer a fix is out. Developer chatter gets no action. Customer replies still follow the reply mode (drafts).',
    ),
    row(
      "Customer → developers",
      config.devRelay,
      "JETTA_DEV_RELAY",
      'In ticket runs, the customer\'s new details and files go onto the open dev item (@Developer); an explicit "any update?" asks the developer once per silence; a how-to question the KB can\'t answer is filed as a Type = Question item (ask_devs).',
    ),
    row(
      "Follow-up on quiet dev items",
      config.devFollowUp,
      "JETTA_DEV_FOLLOWUP",
      `Daily: an open ticket's item with no comment or status change for ${config.devFollowUpRules.quietWorkdays} working days gets an ask to its Developer, a second ask ${config.devFollowUpRules.quietWorkdays} working days later, then one post in the escalation channel. Skips items waiting on the customer, on hold, finished, or feature requests.`,
    ),
    row(
      "Follow-up on unlinked dev items",
      config.devFollowUp === "off" ? "off" : config.devFollowUpUnlinked,
      "JETTA_DEV_FOLLOWUP_UNLINKED",
      "The same daily follow-up for live items with no Freshdesk link that a Reporter filed (the customer named in the title). The Developer is asked; when the item is Waiting Customer or has no Developer, the Reporter is asked instead. Skips Internal Bug, features, and items quiet for over 60 working days. Needs JETTA_DEV_FOLLOWUP on.",
    ),
    row(
      "KB drafts from developers",
      config.devKb,
      "JETTA_DEV_KB",
      "An answered Question item is drafted into the KB review queue; a fixed bug's developer is asked once for an explanation or a doc (PDF, Word, text), and their answer is drafted. Never published without review.",
    ),
  ];
}

/**
 * Which tickets Jetta is allowed to touch at all. These decide whether a run
 * happens — a ticket filtered out here produces no draft, no note and no
 * event, which from the outside is indistinguishable from Jetta ignoring it.
 */
export function rolloutRows(): StatusRow[] {
  const products = config.productFilter;
  // What the filter actually keeps out, rather than what it happens to list.
  const excluded = products.length
    ? (Object.keys(ALL_PRODUCTS) as Product[]).filter((p) => !products.includes(p))
    : [];
  /*
   * Entries that aren't a Product at all. This is the failure worth catching:
   * the filter is a `Product` list, but "product" reads like an app name, so
   * JETTA_PRODUCTS=vlookup is the natural thing to write — and it matches
   * nothing, which means every ticket is skipped and Jetta goes silent with no
   * error anywhere. App-level filtering does not exist; app is AppProduct, and
   * nothing filters on it.
   */
  const invalid = products.filter((p) => !(p in ALL_PRODUCTS));
  const VALID = (Object.keys(ALL_PRODUCTS) as Product[]).join(", ");
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
      tone: invalid.length || excluded.length ? "warn" : "off",
      state: invalid.length
        ? "INVALID"
        : excluded.length
          ? products.join(", ").toUpperCase()
          : "ALL PRODUCTS",
      meaning: invalid.length
        ? `${invalid.join(", ")} ${invalid.length === 1 ? "is not a product" : "are not products"} — the only values that match anything are ${VALID}. ${
            invalid.length === products.length
              ? "Nothing in this list matches, so EVERY email and Freshchat ticket is being skipped and Jetta is doing nothing on them."
              : "Those entries match nothing and narrow the filter further than intended."
          } This filter is board-level, not app-level: there is no way to filter to VLOOKUP or TrackMy alone.`
        : excluded.length
          ? `Email and Freshchat intake is skipped for ${excluded.join(" and ")} — those tickets get no suggestion and no note. Note this is board-level, not app-level: "jetpackapps" is all nine Jetpack apps together, and no filter narrows to one of them. Chat conversations are not filtered.`
          : products.length
            ? `Set, but it names every product (${VALID}), so nothing is excluded — the same as leaving it unset.`
            : `No product is filtered out. The only values this accepts are ${VALID} — it selects a dev-board side of the house, not an individual app.`,
      setting: "JETTA_PRODUCTS",
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
      meaning:
        "Quality-insensitive calls, at a fraction of the cost. It also reads chat screenshots." +
        (config.llm.provider === "openrouter" && lightReasoning(config.llm.models.light.openrouter)
          ? ` Reasoning: ${lightReasoning(config.llm.models.light.openrouter)}.`
          : ""),
      setting: "OPENROUTER_MODEL_LIGHT",
    },
    {
      label: "Dev bridge model — replies to developers' comments",
      tone: "on",
      state: modelLabel("devbridge"),
      meaning:
        modelLabel("devbridge") === modelLabel("standard")
          ? "Same as the standard tier."
          : "A separate model for runs a developer starts on a dev item: it answers them and tells the customer about a fix. Background work, so a slower, more careful model is affordable here.",
      setting: "OPENROUTER_MODEL_DEVBRIDGE",
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
      label: "GetSign knowledge scope",
      tone: config.kbScopeEnabled ? "on" : "off",
      state: config.kbScopeEnabled ? "SCOPED" : "SHARED",
      meaning: config.kbScopeEnabled
        ? "GetSign conversations search only GetSign and shared articles; the portfolio bot is unaffected."
        : "Every conversation searches the whole knowledge base, GetSign and Jetpack apps alike.",
      setting: "JETTA_KB_SCOPE",
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
    appLogsRow(),
    sentryRow(),
    errorWatchRow(),
    selfReviewRow(),
    getsignReferenceRow(),
    releaseWatchRow(),
    teamReportRow(),
    fixLookupRow(),
    repeatProblemsRow(),
    appStateRow(),
    triageShadowRow(),
  ];
}

function appLogsRow(): StatusRow {
  const c = config.cloudwatch;
  const keys = !!(c.accessKeyId && c.secretAccessKey);
  const on = keys && c.enabled;
  return {
    label: "App logs (AWS CloudWatch)",
    tone: on ? "on" : "off",
    state: !keys ? "NO KEYS" : c.enabled ? "READ-ONLY" : "OFF",
    meaning: on
      ? `The Slack and console assistants can search the apps' server logs (search_app_logs), and a dev item filed from a ticket carries that customer's recent log failures, found by their email. Read-only by IAM policy; the ticket agent never sees log lines, so they cannot reach a customer. Region ${c.region}.`
      : !keys
        ? "No AWS credentials (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY), so nothing reads the logs."
        : "Switched off: no log search for the assistants, no log evidence on dev items.",
    setting: "JETTA_APP_LOGS",
  };
}

function errorWatchRow(): StatusRow {
  const w = config.errorWatch;
  const sources = [config.sentry.token && config.sentry.enabled ? "Sentry" : "", config.cloudwatch.accessKeyId && config.cloudwatch.enabled ? "CloudWatch" : "", config.cloudflare.token && config.cloudflare.accountId && config.cloudflare.enabled ? "Cloudflare" : ""].filter(Boolean);
  const on = w.enabled && sources.length > 0;
  return {
    label: "Error watch (Logs page)",
    tone: !on ? "off" : w.devItems === "on" ? "warn" : "on",
    state: !on ? "OFF" : w.devItems === "on" ? "FILES DEV ITEMS" : w.alerts ? "ALERTS" : "WATCHING",
    meaning: on
      ? `Hourly, Jetta reads ${sources.join(" and ")} for the admin-only Logs page: errors per app, new and spiking errors that hit customers (monday accounts from Sentry tags, their chat tickets, any dev item naming the error), and an AI read. ${w.alerts ? `Each newly flagged error is posted once to Slack (${w.channel ? "JETTA_ERROR_WATCH_CHANNEL" : "the ops channel"}).` : "Slack alerts are off (JETTA_ERROR_WATCH_ALERTS=off)."} Dev items for flagged errors with no item: ${w.devItems === "on" ? "FILED on the dev board, at most 2 a day" : w.devItems === "shadow" ? "shadow, listed on the page as \"would file\", nothing filed" : "off"} (JETTA_ERROR_WATCH_DEV_ITEMS). Cloudflare (${config.cloudflare.token && config.cloudflare.enabled ? "on" : config.cloudflare.token ? "off, JETTA_CLOUDFLARE=off" : "no CLOUDFLARE_API_TOKEN"}): edge 5xx per site, Worker errors, firewall blocks and an hourly uptime probe of the busiest hosts; a flagged site or Worker alerts once a day, a host down for an hour every 6h (JETTA_CLOUDFLARE).`
      : !sources.length
        ? "No Sentry token, AWS keys or Cloudflare token, so there is nothing to watch."
        : "Switched off (JETTA_ERROR_WATCH=off): the Logs page shows the last run.",
    setting: "JETTA_ERROR_WATCH",
  };
}

function selfReviewRow(): StatusRow {
  const r = config.selfReview;
  const on = r.enabled && !!config.openrouter.apiKey;
  return {
    label: "Self-review (Self-review page)",
    tone: on ? "on" : "off",
    state: !on ? "OFF" : r.alerts ? "ALERTS" : "WATCHING",
    meaning: on
      ? `Hourly, Jetta checks her own work for the admin-only Self-review page. Reliability: every cron's heartbeat (late or failing), failed runs, runs that ended with no reply, slow runs and new or spiking error events, against her own recent normal. Quality: an independent model (${r.model}, JETTA_SELF_REVIEW_MODEL; never the model that writes replies) grades a few of her recent chat answers, email drafts and dev-bridge replies against what the customer asked and the evidence her run gathered, plus rule checks (internal links, ticket numbers, dead links, links found nowhere in the evidence, a hand-off she told the customer about and did not make). Each problem is marked serious or minor: one serious problem makes a reply bad, minor ones alone make it weak at worst. Actions, no model: from every run's tool calls, a second dev item for one ticket, the same post to developers twice in a day, a ticket closed after it was escalated, a dev item with no repro steps, a board write that did not land, and any subscription cancellation. At most ${r.dailyCap} a day (JETTA_SELF_REVIEW_DAILY). ${r.alerts ? "New reliability problems, new action findings, any chat answer judged bad and a daily scorecard (from 09:00) go to the ops channel." : "Slack posts are off (JETTA_SELF_REVIEW_ALERTS=off)."} Read-only: it changes nothing Jetta does.`
      : !config.openrouter.apiKey
        ? "No OPENROUTER_API_KEY, so there is no judge."
        : "Switched off (JETTA_SELF_REVIEW=off): the Self-review page shows the last run.",
    setting: "JETTA_SELF_REVIEW",
  };
}

function getsignReferenceRow(): StatusRow {
  const on = !!config.getsignReferenceToken;
  return {
    label: "GetSign app reference (KB review queue)",
    tone: on ? "on" : "off",
    state: on ? "DAILY" : "SHIPPED COPY",
    meaning: on
      ? "Daily, with the site sync, Jetta reads the GetSign developers' configuration reference as it is that day. When a section has changed she redrafts the article written from it: an untouched draft is updated in the review queue, an article a person edited or published gets a \"Reference changed\" notice and is never overwritten, and a new section gets a new draft. Nothing is published without a person."
      : "No token for the GetSign app repositories (JETTA_GETSIGN_REFERENCE_TOKEN), so Jetta files the reference articles from the copy shipped with the code and does not notice changes until the next deploy that refreshes it. The release watcher uses the same token and does nothing without it.",
    setting: "JETTA_GETSIGN_REFERENCE_TOKEN",
  };
}

function appStateRow(): StatusRow {
  const mode = config.appState;
  const ready = !!config.getsignApp.baseUrl && !!config.getsignApp.supportKey;
  const on =
    "For a visitor chatting from inside the GetSign app, with a monday session token verified in the last 24 hours, Jetta reads that account's own setup from the GetSign backend: plan and what it includes, settings, the workflows on the board in view, session counts and failures on record. " +
    "She answers from it and never says she looked. Read-only; no signer names or emails, documents or links. A website visitor, or anyone monday has not vouched for, gets no lookup and is asked ordinary questions.";
  if (mode !== "off" && !ready) {
    return {
      label: "Customer app state in chat (GetSign)",
      tone: "warn",
      state: "NOT CONNECTED",
      meaning: `Switched to ${mode}, but the GetSign backend's address or service key is missing (GETSIGN_API_BASE_URL, GETSIGN_SUPPORT_KEY), so nothing is read. When working: ${on}`,
      setting: "JETTA_APP_STATE",
    };
  }
  return {
    label: "Customer app state in chat (GetSign)",
    tone: mode === "on" ? "on" : mode === "shadow" ? "good" : "off",
    state: mode.toUpperCase(),
    meaning:
      mode === "on"
        ? on
        : mode === "shadow"
          ? `Shadow: reads the setup and logs what she would have been shown (appstate.shadow events); her answers are unchanged. When on: ${on}`
          : `Off. When on: ${on}`,
    setting: "JETTA_APP_STATE",
  };
}

function repeatProblemsRow(): StatusRow {
  const mode = config.repeatProblems;
  const on =
    "When a GetSign ticket reports the same malfunction as earlier tickets from other customers, Jetta groups them. " +
    "At three different customers in 30 days, or two when one wrote in after a fix for it was already in production, she tells the developers once on one dev item (an existing one, or one she files, at most two a day) with every ticket listed, and adds each later ticket as one line. " +
    "Support gets a private note on each ticket naming the others and the item. When she files a dev item for a ticket whose problem already has one, it joins that item. " +
    "The reply is written without any of this: she never tells a customer that others are affected.";
  return {
    label: "Repeat problems (same bug, several customers)",
    tone: mode === "on" ? "on" : mode === "shadow" ? "good" : "off",
    state: mode.toUpperCase(),
    meaning:
      mode === "on"
        ? `${on} Posting on dev items also needs MONDAY_ALLOW_WRITES.`
        : mode === "shadow"
          ? `Shadow: groups tickets and logs what it would post or file (problems.shadow events), writes nothing to monday or Freshdesk. When on: ${on}`
          : `Off. When on: ${on}`,
    setting: "JETTA_REPEAT_PROBLEMS",
  };
}

function fixLookupRow(): StatusRow {
  const mode = config.fixLookup;
  const on =
    "When a GetSign ticket arrives, Jetta checks it against the fixes the release watcher has remembered from GitHub. " +
    "A match goes to support in one private note on the ticket: what was fixed, whether it is in production or merged and waiting for a release, and the link. " +
    "If she files a dev item, the same changes go on the item, flagged as a possible cause when they shipped in the last 14 days. " +
    "The reply is written without any of this, so she never tells a customer a fix shipped; that is support's call from the note.";
  if (mode !== "off" && config.releaseWatch === "off") {
    return {
      label: "Fix lookup (already fixed? caused by a release?)",
      tone: "warn",
      state: "NOTHING TO READ",
      meaning: `Switched to ${mode}, but the release watcher is off (JETTA_RELEASE_WATCH), so no fixes are being remembered and every lookup comes back empty. When working: ${on}`,
      setting: "JETTA_FIX_LOOKUP",
    };
  }
  return {
    label: "Fix lookup (already fixed? caused by a release?)",
    tone: mode === "on" ? "on" : mode === "shadow" ? "good" : "off",
    state: mode.toUpperCase(),
    meaning:
      mode === "on"
        ? on
        : mode === "shadow"
          ? `Shadow: looks up every GetSign ticket and logs what it would write (fixlookup.shadow events), writes nothing. When on: ${on}`
          : `Off. When on: ${on}`,
    setting: "JETTA_FIX_LOOKUP",
  };
}

function teamReportRow(): StatusRow {
  const channel = config.teamReport.channel;
  const what =
    "a short report each morning (03:30 UTC) about the day before, as two Slack tables (To do, then Team with the columns Name, Freshdesk, monday dev boards, Other), every ticket and dev item a link; plain lines instead if Slack refuses the tables. " +
    "First line: new tickets, answered, median first reply, customers waiting on us. " +
    "To do, only when there is something: Reply (customers waiting over 4 hours, longest first), Reply or close (over 14 days), and developer updates the customer has not been told about, from the Dev board: Relay dev update, Dev needs customer info, Fixed tell customer (resolved in the last 7 days), each only while its ticket is open and nobody has written to the customer since. A memo mark means Jetta's draft is on the ticket. " +
    "Team: two groups, the support team (DEV_BOARD_SUPPORT) then developers and everyone else, one line per person, alphabetical inside each group and not ranked; each count is a link that opens Team activity on those actions for that person and day. Per person: with Freshdesk replies (tickets linked), first replies, chats, both monday dev boards, Slack and console decisions. Jetta is on the list too: replies she sent herself (first responses and follow-ups), drafts written and how they were used, dev items filed, handoffs. " +
    "Someone with nothing recorded is left out; names are merged the way Team activity merges them (AGENT_ALIASES); \"yesterday\" is the calendar day in JETTA_TEAM_REPORT_TZ (unset: JETTA_TZ); a day with nothing is skipped. Worked out by rule from the Team activity, Performance, Support health and Dev board stores, not written by a model. " +
    "Admins can read the exact text for any day, without posting, at /api/admin/team-report?day=YYYY-MM-DD.";
  return {
    label: "Daily team report (Slack)",
    tone: channel ? "on" : "off",
    state: channel ? "POSTING" : "OFF",
    meaning: channel
      ? `Posts to ${channel}: ${what} The post goes only to that channel; if Jetta is not in it, nothing is posted and the cron reports the failure.`
      : `Off: no channel is set. When JETTA_TEAM_REPORT_CHANNEL holds a Slack channel id, Jetta posts ${what}`,
    setting: "JETTA_TEAM_REPORT_CHANNEL",
  };
}

function releaseWatchRow(): StatusRow {
  const mode = config.releaseWatch;
  const on =
    "Hourly, Jetta reads what the GetSign team merged into production on GitHub (board view, backend, application, item view). " +
    "When a shipped fix looks like the fix for an open dev item she asks the Developer on that item; the developer confirms by changing Dev Status, and only then is the customer told (Developers → customer). " +
    'Published KB articles about the changed area get a "Release changed" notice in the review queue, and one what-shipped note goes to Slack. She never tells a customer a fix shipped on her own guess.';
  if (mode !== "off" && !config.getsignReferenceToken) {
    return {
      label: "Release watcher (GitHub → dev items, KB, Slack)",
      tone: "warn",
      state: "NO TOKEN",
      meaning: `Switched to ${mode} but there is no token for the GetSign app repositories (JETTA_GETSIGN_REFERENCE_TOKEN), so nothing is read. When working: ${on}`,
      setting: "JETTA_RELEASE_WATCH",
    };
  }
  return {
    label: "Release watcher (GitHub → dev items, KB, Slack)",
    tone: mode === "on" ? "on" : mode === "shadow" ? "good" : "off",
    state: mode.toUpperCase(),
    meaning:
      mode === "on"
        ? `${on} Comments on dev items also need MONDAY_ALLOW_WRITES.`
        : mode === "shadow"
          ? `Shadow: works out what it would do and logs it (release.* events), writes nothing. When on: ${on}`
          : `Off. When on: ${on}`,
    setting: "JETTA_RELEASE_WATCH",
  };
}

function triageShadowRow(): StatusRow {
  const on = config.triageShadow;
  return {
    label: "GetSign triage (shadow)",
    tone: on ? "on" : "off",
    state: on ? "SHADOW" : "OFF",
    meaning: on
      ? "On a new GetSign ticket, Jetta adds one private note with her call: a setup problem the customer can fix (with what to check and the usual fix), a how-to question, a missing feature, a likely bug, or unsure. Nothing is sent to the customer or routed by it, and the reply agent never reads it; the team's own reply grades it. Playbook built from 90 days of resolved GetSign tickets."
      : "Off: no triage note on GetSign tickets.",
    setting: "JETTA_TRIAGE_SHADOW",
  };
}

function sentryRow(): StatusRow {
  const c = config.sentry;
  const on = !!c.token && c.enabled;
  return {
    label: "Error tracker (Sentry)",
    tone: on ? "on" : "off",
    state: !c.token ? "NO TOKEN" : c.enabled ? "READ-ONLY" : "OFF",
    meaning: on
      ? `The Slack and console assistants can search Sentry (search_sentry): grouped errors per app with counts, users, first/last seen and links, including the GetSign frontend. A dev item filed from a ticket lists the Sentry issues tagged with that customer's monday account (GetSign backend, Extract AI). Read-only integration token; the ticket agent never sees Sentry results, so they cannot reach a customer. Org ${c.org}.`
      : !c.token
        ? "No SENTRY_AUTH_TOKEN, so nothing reads Sentry."
        : "Switched off: no Sentry search for the assistants, no Sentry issues on dev items.",
    setting: "JETTA_SENTRY",
  };
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
      : config.firstResponse === "on"
        ? "Jetta sends the first reply on direct email tickets; every later reply waits for a human."
        : "Every Freshdesk reply waits for a human.",
    anchor: "capabilities",
  });

  const products = config.productFilter;
  // Only a filter that actually excludes a product is worth a chip. One naming
  // every product restricts nothing, and a permanent amber badge for nothing is
  // how people learn to stop reading the bar.
  if (
    products.length &&
    (Object.keys(ALL_PRODUCTS) as Product[]).some((p) => !products.includes(p))
  ) {
    rows.push({
      label: "Product filter",
      tone: "warn",
      state: products.join(", ").toUpperCase(),
      meaning:
        "Email and Freshchat intake outside this list is skipped before the agent runs. Chat conversations are not filtered.",
      anchor: "rollout",
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
  { path: "POST /api/admin/run", detail: "This console's ticket runner (a preview for any login; a live run is admin only)" },
] as const;

export const CRONS: readonly EndpointRow[] = [
  {
    path: "/api/cron/followup",
    detail: "Backstop: a customer reply the webhook never answered gets a Jetta run, 24h+ after a resolution was sent",
    schedule: "daily 09:00",
  },
  {
    path: "/api/cron/ticket-followup",
    detail:
      "Follows up with customers who went quiet after our reply: check-in after 2 business days, nudge after 3 more, close after 3 more. Each touch sits on the ticket as a private note for an hour first; any reply or the jetta-hold tag stops it. Armed by JETTA_TICKET_FOLLOWUP=on",
    schedule: "every 20 min",
  },
  { path: "/api/cron/first-response", detail: "Sends the first replies Jetta scheduled on direct tickets, after re-reading the ticket; armed by JETTA_FIRST_RESPONSE=on", schedule: "every minute" },
  { path: "/api/cron/chat-followup", detail: "Chat sweep: one check-in after 15 min of visitor silence, auto-resolve after 24h", schedule: "every 5 min" },
  { path: "/api/cron/kb-sync", detail: "Re-crawls the sites into the knowledge base, and files the GetSign app reference articles as review-queue drafts", schedule: "daily 05:00" },
  { path: "/api/cron/reconcile-drafts", detail: "Matches suggestions to what humans actually sent", schedule: "hourly at :15" },
  { path: "/api/cron/daily-overview", detail: "Yesterday's rollup and its written narrative", schedule: "daily 06:10" },
  { path: "/api/cron/performance-sync", detail: "Reads changed Freshdesk tickets into the Support health and Performance stores", schedule: "hourly at :40" },
  { path: "/api/cron/activity-sync", detail: "Reads Slack, monday and the KB audit into Team activity", schedule: "hourly at :25" },
  { path: "/api/cron/ticket-sync", detail: "Copies changed Freshdesk tickets and messages into Jetta's own Postgres ticket store, then backfills 180 days of history with leftover API budget. Reads Freshdesk only; idle when DATABASE_URL is unset", schedule: "every 5 min" },
  { path: "/api/cron/dev-board-sync", detail: "Reads both monday dev boards (read-only) and analyses new item conversations for Dev board", schedule: "hourly at :50" },
  { path: "/api/cron/self-review", detail: "Jetta's self-review for the Self-review page: cron heartbeats, run failures and latency, error events, and an independent model grading a few recent replies; posts problems and a daily scorecard to the ops channel. Off with JETTA_SELF_REVIEW=off", schedule: "hourly at :45" },
  { path: "/api/cron/error-watch", detail: "Reads Sentry, the app logs and Cloudflare for the Logs page: flags new and spiking errors hitting customers, alerts Slack, lists or files dev items (JETTA_ERROR_WATCH_DEV_ITEMS), writes the AI read. Off with JETTA_ERROR_WATCH=off", schedule: "hourly at :35" },
  { path: "/api/cron/dev-followup", detail: "Asks developers for an update on quiet dev items a customer is waiting on; escalates after two unanswered asks. Armed by JETTA_DEV_FOLLOWUP", schedule: "daily 04:30" },
  { path: "/api/cron/release-watch", detail: "Reads what the GetSign team merged into production on GitHub: asks the Developer on an open dev item whether a shipped fix resolves it, files \"Release changed\" notices in the KB review queue, posts a what-shipped note to Slack. Armed by JETTA_RELEASE_WATCH; needs JETTA_GETSIGN_REFERENCE_TOKEN", schedule: "hourly at :20" },
  { path: "/api/cron/team-report", detail: "Posts yesterday's per-person team report to Slack (Freshdesk, chats, Slack, monday dev boards, console, plus the team line and Jetta's block), once a day, from the Team activity and Performance stores. Posts nothing until JETTA_TEAM_REPORT_CHANNEL is set", schedule: "daily 03:30" },
] as const;
