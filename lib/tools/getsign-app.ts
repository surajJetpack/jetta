/**
 * The customer's own GetSign setup, read from the GetSign backend so Jetta
 * can answer from what is true for them instead of asking.
 *
 * WHO IT IS READ FOR. Only an account monday itself vouched for: a chat
 * opened inside the GetSign app with a signed session token that has an
 * expiry and names the GetSign app (lib/monday-session-token.ts). The account
 * id sent to the backend is the one from that token, never one the page
 * claimed or the model produced. A visitor who typed an email on the website
 * gets no lookup, because that visitor could be anyone.
 *
 * HOW. Jetta holds no customer credential. She asks the backend one question
 * with a service key: `GET /api/v3/internal/support/accounts/:id/state`. The
 * board id is a claim from the page, which is safe because the backend only
 * returns workflows on that board that belong to the account in the path.
 *
 * WHAT COMES BACK is setup and status: plan, settings, workflow configuration,
 * session counts, stored failures. Not signer names or emails, IP addresses,
 * document contents, file links or tokens. The backend leaves those out, and
 * `sanitizeAppState` here builds the result field by field from an allow-list,
 * so a mistake on the other side cannot put a signer's email in a prompt.
 *
 * WHAT THE CUSTOMER HEARS. Nothing about the lookup. Jetta states what is
 * true of their setup and never says she looked (lib/system-prompt.ts).
 *
 * Switches: JETTA_APP_STATE off / shadow / on, and it does nothing without
 * GETSIGN_API_BASE_URL and GETSIGN_SUPPORT_KEY. Not gated on stub mode:
 * production runs with STUB_MODE on (scripts/stub-mode-gates-test.ts).
 */
import { config } from "../config";
import { logOpsEvent } from "../events";
import { kvGet, kvSet } from "../kv";
import { log } from "../logger";
import type { ChatConversation } from "../types";

/** How long a verified session token keeps unlocking app state. */
export const APP_STATE_VERIFIED_HOURS = 24;
const CACHE_SECONDS = 5 * 60;
const TIMEOUT_MS = 10_000;
/** The header the backend's support guard reads. */
export const SUPPORT_KEY_HEADER = "x-support-key";

// ── The shape (the contract with the backend) ──────────────────────

export interface AppWorkflow {
  name: string;
  /** "template", "generate", "hybrid"… */
  type?: string;
  /** Setup progress: "initialized", "settings-configured", "template-created". */
  status?: string;
  signatureCollection?: boolean;
  /** The board columns a signer's email is read from. Empty: none is mapped. */
  recipientColumns: { title: string; type?: string }[];
  signAnywhere?: boolean;
  signingOrderRequired?: boolean;
  /** Sends by itself when this column takes this value. Null: no auto-send. */
  autoSend?: { column?: string; value?: string } | null;
  remindersEnabled?: boolean;
  reminderHours?: number[];
  /** Null: links do not expire. */
  linkExpiryMinutes?: number | null;
  senderEmailVerified?: boolean;
  generateDocument?: boolean;
  shareAndTrack?: boolean;
  otpRequired?: boolean;
  inheritsEmailSettings?: boolean;
  inheritsSecuritySettings?: boolean;
  templates: { name: string; type?: string }[];
}

export interface AppState {
  account: {
    status?: string;
    installState?: string;
    timeZone?: string;
    remindersEnabled?: boolean;
    reminderHours?: number[];
    otpRequired?: boolean;
    digitalCertification?: boolean;
    senderEmailSet?: boolean;
  };
  plan: {
    name?: string;
    isTrial?: boolean;
    daysLeft?: number | null;
    /** Feature name → available on this plan. */
    features: Record<string, boolean>;
    usage?: { sent?: number; generated?: number; sendLimit?: number | null; generateLimit?: number | null };
  };
  /** Workflows on the board the customer is looking at. */
  workflows: AppWorkflow[];
  sessions?: {
    total?: number;
    completed?: number;
    awaiting?: number;
    recent: { itemName?: string; status: string; at?: string }[];
  };
  /** Failures the backend has on record, newest first. */
  failures: { kind: string; message: string; itemName?: string; at?: string }[];
}

// ── Allow-list ─────────────────────────────────────────────────────

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const numOrNull = (v: unknown): number | null | undefined => (v === null ? null : num(v));

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
/**
 * A short piece of text that is safe to quote in a prompt: one line, capped,
 * and with anything shaped like an email address removed. Free text from a
 * customer's board is data, and a signer's address must not ride along in an
 * error message.
 */
function text(v: unknown, max = 120): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.replace(/\s+/g, " ").replace(EMAIL, "[email]").trim().slice(0, max);
  return t || undefined;
}
const numbers = (v: unknown) => arr(v).map(num).filter((n): n is number => n !== undefined).slice(0, 6);

/**
 * Build an AppState from whatever the backend sent, taking only the fields
 * named here. Anything else, a signer's email or a document's text included,
 * is not copied because nothing here asks for it. Returns null when the
 * response is not an object at all. Pure.
 */
export function sanitizeAppState(raw: unknown): AppState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Raw;
  const account = obj(r.account);
  const plan = obj(r.plan);
  const usage = obj(plan.usage);
  const sessions = obj(r.sessions);

  const features: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(obj(plan.features)).slice(0, 30)) {
    if (/^[a-zA-Z0-9_ -]{1,40}$/.test(k) && typeof v === "boolean") features[k] = v;
  }

  return {
    account: {
      status: text(account.status, 40),
      installState: text(account.installState, 40),
      timeZone: text(account.timeZone, 60),
      remindersEnabled: bool(account.remindersEnabled),
      reminderHours: numbers(account.reminderHours),
      otpRequired: bool(account.otpRequired),
      digitalCertification: bool(account.digitalCertification),
      senderEmailSet: bool(account.senderEmailSet),
    },
    plan: {
      name: text(plan.name, 60),
      isTrial: bool(plan.isTrial),
      daysLeft: numOrNull(plan.daysLeft),
      features,
      ...(Object.keys(usage).length
        ? { usage: { sent: num(usage.sent), generated: num(usage.generated), sendLimit: numOrNull(usage.sendLimit), generateLimit: numOrNull(usage.generateLimit) } }
        : {}),
    },
    workflows: arr(r.workflows)
      .slice(0, 12)
      .map((w): AppWorkflow | null => {
        const x = obj(w);
        const name = text(x.name, 100);
        if (!name) return null;
        const auto = x.autoSend === null ? null : obj(x.autoSend);
        return {
          name,
          type: text(x.type, 30),
          status: text(x.status, 40),
          signatureCollection: bool(x.signatureCollection),
          recipientColumns: arr(x.recipientColumns)
            .slice(0, 8)
            .map((c) => ({ title: text(obj(c).title, 60) ?? "", type: text(obj(c).type, 30) }))
            .filter((c) => c.title),
          signAnywhere: bool(x.signAnywhere),
          signingOrderRequired: bool(x.signingOrderRequired),
          autoSend: auto === null ? null : Object.keys(auto).length ? { column: text(auto.column, 60), value: text(auto.value, 60) } : undefined,
          remindersEnabled: bool(x.remindersEnabled),
          reminderHours: numbers(x.reminderHours),
          linkExpiryMinutes: numOrNull(x.linkExpiryMinutes),
          senderEmailVerified: bool(x.senderEmailVerified),
          generateDocument: bool(x.generateDocument),
          shareAndTrack: bool(x.shareAndTrack),
          otpRequired: bool(x.otpRequired),
          inheritsEmailSettings: bool(x.inheritsEmailSettings),
          inheritsSecuritySettings: bool(x.inheritsSecuritySettings),
          templates: arr(x.templates)
            .slice(0, 10)
            .map((t) => ({ name: text(obj(t).name, 100) ?? "", type: text(obj(t).type, 20) }))
            .filter((t) => t.name),
        };
      })
      .filter((w): w is AppWorkflow => w !== null),
    ...(Object.keys(sessions).length
      ? {
          sessions: {
            total: num(sessions.total),
            completed: num(sessions.completed),
            awaiting: num(sessions.awaiting),
            recent: arr(sessions.recent)
              .slice(0, 8)
              .map((s) => ({ itemName: text(obj(s).itemName, 80), status: text(obj(s).status, 40) ?? "", at: text(obj(s).at, 30) }))
              .filter((s) => s.status),
          },
        }
      : {}),
    failures: arr(r.failures)
      .slice(0, 8)
      .map((f) => ({ kind: text(obj(f).kind, 30) ?? "", message: text(obj(f).message, 240) ?? "", itemName: text(obj(f).itemName, 80), at: text(obj(f).at, 30) }))
      .filter((f) => f.kind && f.message),
  };
}

// ── Reading ────────────────────────────────────────────────────────

/** Both the address and the key are set. Stub mode has no say (see the header). */
export function appStateReady(): boolean {
  return !!config.getsignApp.baseUrl && !!config.getsignApp.supportKey;
}

export type AppStateResult = { ok: true; state: AppState } | { ok: false; reason: "not_ready" | "failed" };

/**
 * One GET. `accountId` must come from a verified token; this function does
 * not and cannot check that, so its only caller does (`appStateForChat`).
 * "failed" covers every way of not getting an answer: it is never turned into
 * an empty state, which would read as "this customer has no workflows".
 */
export async function getAppState(accountId: string, boardId?: string, fetcher: typeof fetch = fetch): Promise<AppStateResult> {
  if (!appStateReady()) return { ok: false, reason: "not_ready" };
  if (!/^\d{1,20}$/.test(accountId)) return { ok: false, reason: "failed" };
  const base = config.getsignApp.baseUrl!.replace(/\/+$/, "");
  const query = boardId && /^\d{1,20}$/.test(boardId) ? `?boardId=${boardId}` : "";
  try {
    const res = await fetcher(`${base}/api/v3/internal/support/accounts/${accountId}/state${query}`, {
      headers: { [SUPPORT_KEY_HEADER]: config.getsignApp.supportKey!, Accept: "application/json", "User-Agent": "jetta-support" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`the GetSign backend answered ${res.status}`);
    const state = sanitizeAppState(await res.json());
    if (!state) throw new Error("the GetSign backend's answer was not an object");
    return { ok: true, state };
  } catch (e) {
    log.warn("appstate.fetch_failed", { error: e instanceof Error ? e.message : String(e), source: "jettachat" });
    return { ok: false, reason: "failed" };
  }
}

/**
 * May this conversation's app state be read? Pure.
 *
 * Stricter than `mondayAccountVerified`, which unlocks a trial request:
 *  - the token had an expiry, and named the GetSign app where an app id is
 *    configured (`mondayTokenStrict`);
 *  - it was verified recently. A conversation can be resumed for a day and
 *    kept for months; "monday vouched for this once" must not mean forever.
 */
export function mayReadAppState(conv: Pick<ChatConversation, "visitor">, now = new Date()): boolean {
  const v = conv.visitor;
  if (v.app !== "getsign" || v.mondayAccountVerified !== true || v.mondayTokenStrict !== true) return false;
  if (!v.mondayAccountId || !v.mondayVerifiedAt) return false;
  return now.getTime() / 1000 - v.mondayVerifiedAt <= APP_STATE_VERIFIED_HOURS * 3600;
}

const cacheKey = (conversationId: string) => `jetta:chat:appstate:${conversationId}`;

/**
 * The app state to put in front of Jetta for this chat, or undefined.
 *
 *  - undefined: not eligible, switched off, shadow, not configured.
 *  - "unknown": she is allowed to know and the lookup failed.
 *  - AppState: what is true of this customer's setup.
 *
 * Cached for a few minutes per conversation: a chat is several turns close
 * together, and the setup does not change between them.
 */
export async function appStateForChat(
  conv: ChatConversation,
  opts: { now?: Date; fetcher?: typeof fetch } = {},
): Promise<AppState | "unknown" | undefined> {
  const mode = config.appState;
  if (mode === "off" || !appStateReady() || !mayReadAppState(conv, opts.now)) return undefined;

  let state: AppState | null = null;
  const cached = await kvGet(cacheKey(conv.id)).catch(() => null);
  if (cached) {
    state = sanitizeAppState(typeof cached === "string" ? JSON.parse(cached) : cached);
  } else {
    const got = await getAppState(conv.visitor.mondayAccountId!, conv.visitor.mondayBoardId, opts.fetcher);
    if (!got.ok) return mode === "on" ? "unknown" : undefined;
    state = got.state;
    await kvSet(cacheKey(conv.id), JSON.stringify(state), CACHE_SECONDS).catch(() => {});
    if (mode === "shadow") {
      // Once per fetch, not per turn: what she would have been shown.
      await logOpsEvent({ level: "info", event: "appstate.shadow", source: "jettachat", data: { conversationId: conv.id, shown: renderAppState(state) } });
    }
  }
  return mode === "on" && state ? state : undefined;
}

// ── What Jetta is shown ────────────────────────────────────────────

const yn = (b: boolean | undefined, yes: string | null, no: string | null) => (b === undefined ? null : b ? yes : no);
const hours = (h: number[] | undefined) => (h?.length ? ` (after ${h.join(" and ")} hours)` : "");

/** The account block for the prompt: plain statements, one per line. Pure. */
export function renderAppState(s: AppState): string {
  const lines: string[] = [];
  const a = s.account;
  const p = s.plan;

  const planBits = [
    p.name ? `plan ${p.name}` : null,
    p.isTrial ? `on trial${typeof p.daysLeft === "number" ? `, ${p.daysLeft} days left` : ""}` : null,
    a.status ? `account status ${a.status}` : null,
    a.installState && a.installState !== "installed" ? `app ${a.installState}` : null,
  ].filter(Boolean);
  if (planBits.length) lines.push(`  Account: ${planBits.join("; ")}.`);

  const on = Object.entries(p.features).filter(([, v]) => v).map(([k]) => k);
  const offF = Object.entries(p.features).filter(([, v]) => !v).map(([k]) => k);
  if (on.length) lines.push(`  Included in their plan: ${on.join(", ")}.`);
  if (offF.length) lines.push(`  NOT included in their plan: ${offF.join(", ")}.`);

  const u = p.usage;
  if (u && (u.sent !== undefined || u.generated !== undefined)) {
    const part = (label: string, used?: number, limit?: number | null) =>
      used === undefined ? null : `${used} ${label}${typeof limit === "number" ? ` of ${limit}` : ""}`;
    lines.push(`  Usage this period: ${[part("sent", u.sent, u.sendLimit), part("generated", u.generated, u.generateLimit)].filter(Boolean).join(", ")}.`);
  }

  const settings = [
    yn(a.senderEmailSet, "a sender email is set", "NO sender email is set"),
    yn(a.remindersEnabled, `reminders on${hours(a.reminderHours)}`, "reminders off"),
    yn(a.otpRequired, "signers must enter a one-time code", null),
    yn(a.digitalCertification, "digital certification on", null),
    a.timeZone ? `time zone ${a.timeZone}` : null,
  ].filter(Boolean);
  if (settings.length) lines.push(`  Account settings: ${settings.join("; ")}.`);

  if (s.workflows.length) {
    lines.push(`  Workflows on the board they are on (${s.workflows.length}):`);
    for (const w of s.workflows) {
      const bits = [
        w.type ? `type ${w.type}` : null,
        w.status && w.status !== "template-created" ? `setup not finished (${w.status})` : null,
        w.signatureCollection === false
          ? "signature collection OFF"
          : w.recipientColumns.length
            ? `signer email read from: ${w.recipientColumns.map((c) => `"${c.title}"${c.type ? ` (${c.type})` : ""}`).join(", ")}`
            : "NO column is mapped for the signer's email",
        yn(w.signingOrderRequired, "signing order required", null),
        yn(w.signAnywhere, "Sign Anywhere on", null),
        w.autoSend === null ? "no auto-send" : w.autoSend ? `auto-sends when "${w.autoSend.column ?? "a column"}" is "${w.autoSend.value ?? "set"}"` : null,
        yn(w.senderEmailVerified, null, "sender email NOT verified"),
        yn(w.remindersEnabled, `reminders on${hours(w.reminderHours)}`, "reminders off"),
        w.linkExpiryMinutes === null ? "links do not expire" : typeof w.linkExpiryMinutes === "number" ? `links expire after ${w.linkExpiryMinutes} minutes` : null,
        yn(w.generateDocument, "document generation on", null),
        yn(w.otpRequired, "one-time code required", null),
        w.templates.length ? `templates: ${w.templates.map((t) => `"${t.name}"${t.type ? ` (${t.type})` : ""}`).join(", ")}` : "NO template attached",
      ].filter(Boolean);
      lines.push(`    - "${w.name}": ${bits.join("; ")}.`);
    }
  } else {
    lines.push(`  Workflows on the board they are on: none.`);
  }

  if (s.sessions) {
    const c = s.sessions;
    const counts = [
      c.total !== undefined ? `${c.total} in all` : null,
      c.awaiting !== undefined ? `${c.awaiting} awaiting signature` : null,
      c.completed !== undefined ? `${c.completed} completed` : null,
    ].filter(Boolean);
    if (counts.length) lines.push(`  Signing sessions on this board: ${counts.join(", ")}.`);
    if (c.recent.length) lines.push(`  Most recent: ${c.recent.map((r) => `${r.itemName ? `"${r.itemName}" ` : ""}${r.status}`).join("; ")}.`);
  }

  if (s.failures.length) {
    lines.push(`  Recent failures on record:`);
    for (const f of s.failures) lines.push(`    - ${f.kind}${f.itemName ? ` on "${f.itemName}"` : ""}${f.at ? ` (${f.at.slice(0, 10)})` : ""}: ${f.message}`);
  }
  return lines.join("\n");
}
