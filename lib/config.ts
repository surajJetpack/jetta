/**
 * Central environment + runtime configuration for Jetta.
 *
 * Everything reads from here so the rest of the codebase never touches
 * `process.env` directly. `STUB_MODE` is the master switch that makes every
 * external tool client return canned data — it lets the whole app run and be
 * tested end-to-end before any live credential exists.
 */

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

/** Read a required var; throws at call time (not import time) if missing. */
export function requireEnv(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

/**
 * Stub mode is ON by default unless STUB_MODE is explicitly "false".
 * This keeps the deployment safe: without credentials it cannot accidentally
 * hit a real billing or escalation API.
 */
export const STUB_MODE = env("STUB_MODE") !== "false";

/**
 * Per-integration live switch. An integration goes live if STUB_MODE is off
 * globally, OR its own `<NAME>_LIVE=true` flag is set. This enables a staged
 * rollout — e.g. Freshdesk live while FastSpring/monday/Slack stay stubbed.
 */
function liveFor(flag: string): boolean {
  return !STUB_MODE || env(flag) === "true";
}

/**
 * LLM provider. Defaults to Google (Gemini) when a Gemini key is present,
 * else Anthropic (Claude — the production target per the product spec).
 * Override explicitly with LLM_PROVIDER=google|anthropic.
 */
export type LlmProvider = "google" | "anthropic";
const explicitProvider = env("LLM_PROVIDER") as LlmProvider | undefined;
export const LLM_PROVIDER: LlmProvider =
  explicitProvider ??
  (env("GOOGLE_GENERATIVE_AI_API_KEY") ? "google" : "anthropic");

export const config = {
  stubMode: STUB_MODE,

  llm: {
    provider: LLM_PROVIDER,
    /** Per-provider model ids. Swap the production model here, not in code. */
    models: {
      google: "gemini-2.5-pro",
      anthropic: "claude-sonnet-4-6",
    } as Record<LlmProvider, string>,
    /** Max tool-loop steps per turn — bounds runaway loops. */
    maxSteps: 10,
    maxTokens: 4096,
  },

  google: {
    apiKey: env("GOOGLE_GENERATIVE_AI_API_KEY"),
  },
  anthropic: {
    apiKey: env("ANTHROPIC_API_KEY"),
  },

  freshdesk: {
    apiKey: env("FRESHDESK_API_KEY"),
    domain: env("FRESHDESK_DOMAIN"),
    live: liveFor("FRESHDESK_LIVE"),
  },

  freshchat: {
    live: liveFor("FRESHCHAT_LIVE"),
    apiToken: env("FRESHCHAT_API_TOKEN"),
    /**
     * Full API base including the version segment, e.g.
     * https://jetpackapps.freshchat.com/v2 — regional domains vary, so we take
     * the whole base rather than deriving it from an account name.
     */
    apiUrl: (env("FRESHCHAT_API_URL") ?? "").replace(/\/$/, ""),
    /** Jetta's Freshchat agent id — actor_id for outbound messages and the loop-prevention self-id. */
    agentId: env("FRESHCHAT_AGENT_ID"),
    /** Group Freddy hands off to; conversations assigned here (or to agentId) are Jetta's. */
    handoffGroupId: env("FRESHCHAT_HANDOFF_GROUP_ID"),
    /** PEM public key from Freshchat admin → webhooks, verifies X-Freshchat-Signature. */
    webhookPublicKey: env("FRESHCHAT_WEBHOOK_PUBLIC_KEY"),
    /** Agent-console base for deep links in escalations, e.g. https://jetpackapps.myfreshworks.com/crm/messaging */
    webUrl: (env("FRESHCHAT_WEB_URL") ?? "").replace(/\/$/, ""),
    /** Multi-message debounce window before the agent runs (seconds). */
    debounceSeconds: Number(env("FRESHCHAT_DEBOUNCE_SECONDS") ?? "8"),
  },

  fastspring: {
    live: liveFor("FASTSPRING_LIVE"),
    username: env("FASTSPRING_API_USERNAME"),
    password: env("FASTSPRING_API_PASSWORD"),
    retentionCoupon: env("FASTSPRING_RETENTION_COUPON") ?? "RETAIN20",
  },

  monday: {
    live: liveFor("MONDAY_LIVE"),
    apiToken: env("MONDAY_API_TOKEN"),
    devBoardId: env("MONDAY_DEV_BOARD_ID"),
    // Account subdomain for deep links, e.g. https://jetpackteam.monday.com
    accountUrl: (env("MONDAY_ACCOUNT_URL") ?? "https://monday.com").replace(/\/$/, ""),
  },

  slack: {
    live: liveFor("SLACK_LIVE"),
    botToken: env("SLACK_BOT_TOKEN"),
    escalationChannel: env("SLACK_ESCALATION_CHANNEL"),
    partnershipsChannel: env("SLACK_PARTNERSHIPS_CHANNEL"),
    signingSecret: env("SLACK_SIGNING_SECRET"),
    adminUserIds: (env("ADMIN_SLACK_USER_IDS") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },

  webhook: {
    secret: env("WEBHOOK_SECRET"),
  },

  /** Gates the ops console UI + /api/admin/* (the webhook stays public, secret-gated). */
  adminSecret: env("ADMIN_SECRET"),

  /**
   * Controlled-rollout allowlist. When non-empty, Jetta only performs LIVE
   * writes (reply, note, escalate, monday item, etc.) on these ticket IDs; any
   * other ticket is automatically forced to dry-run (reasons but writes nothing).
   * Dry-run requests are never affected. Empty = no restriction (writes on all).
   */
  ticketAllowlist: (env("JETTA_TICKET_ALLOWLIST") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  kv: {
    // Accept both the legacy Vercel KV names and the Upstash Marketplace names,
    // so whichever the integration injects works without code changes.
    url: env("KV_REST_API_URL") ?? env("UPSTASH_REDIS_REST_URL"),
    token: env("KV_REST_API_TOKEN") ?? env("UPSTASH_REDIS_REST_TOKEN"),
  },

  vector: {
    url: env("UPSTASH_VECTOR_REST_URL"),
    token: env("UPSTASH_VECTOR_REST_TOKEN"),
    /**
     * Hybrid mode: point at an Upstash HYBRID index (hosted dense embedding
     * model + BM25 sparse, created that way in the console) and set
     * UPSTASH_VECTOR_HYBRID=true. Upserts/queries then send raw text and
     * Upstash embeds server-side — no client-side Gemini embedding call.
     * Leave unset for the legacy client-embedded dense index (rollback path).
     */
    hybrid: env("UPSTASH_VECTOR_HYBRID") === "true",
    /** Legacy dense mode: Gemini embedding model + dimension (index must match). */
    embedModel: "gemini-embedding-001",
    dimension: 768,
  },

  /** LLM-as-reranker for KB retrieval (RERANK_ENABLED=false to kill-switch). */
  rerank: {
    enabled: env("RERANK_ENABLED") !== "false",
    /** Cheap + fast; quality is judged by scripts/kb-eval.ts, not vibes. */
    models: {
      google: "gemini-2.5-flash-lite",
      anthropic: "claude-haiku-4-5",
    } as Record<LlmProvider, string>,
    timeoutMs: 3500,
  },

  liveSessionBookingUrl:
    env("LIVE_SESSION_BOOKING_URL") ?? "https://jetpackapps.io/book-a-session",
} as const;
