/**
 * The tickets Jetta has seen lately and the problems they form: her memory
 * for noticing that a new ticket is the same malfunction as earlier ones
 * (lib/problems.ts).
 *
 * Two Redis hashes, read whole. A support desk sees a few hundred tickets in
 * the window, each kept as a subject and an opening paragraph.
 */
import { Redis } from "@upstash/redis";
import { config } from "./config";

const SEEN_KEY = "jetta:problems:tickets:v1";
const PROBLEMS_KEY = "jetta:problems:v1";
/** Tickets older than this are no longer compared against. */
export const PROBLEM_KEEP_DAYS = 45;
const DAY_MS = 24 * 3600 * 1000;

/** One ticket as it is remembered for comparison. */
export interface SeenTicket {
  id: string;
  /** When Jetta first saw it. ISO. */
  at: string;
  subject: string;
  /** The customer's opening message, trimmed. */
  text: string;
  /**
   * What is failing, in one sentence, with any error message quoted. Unset
   * for a ticket that is not a malfunction: those are never compared.
   */
  symptom?: string;
  /** A short hash of who wrote in, so one customer's two tickets count once. Never the address itself. */
  who?: string;
  /** The problem it belongs to, once it matched another ticket. */
  problemId?: string;
}

/** Several tickets about one malfunction. */
export interface Problem {
  id: string;
  /** The first ticket's subject: what a developer will read. */
  title: string;
  tickets: { id: string; at: string; subject: string; who?: string; symptom?: string }[];
  /** Tickets that arrived although a fix for this was already in production. */
  afterFix: string[];
  /** Those fixes, for the developer. */
  fixes: { key: string; summary: string; when: string; urls: string[] }[];
  /** The dev item that carries the problem, once raised. */
  itemId?: string;
  itemUrl?: string;
  /** When the developers were first told. ISO. */
  raisedAt?: string;
  /** Tickets already listed on the dev item, so none is announced twice. */
  told?: string[];
}

let redis: Redis | null = null;
function client(): Redis | null {
  if (config.kv.url && config.kv.token) {
    redis ??= new Redis({ url: config.kv.url, token: config.kv.token });
    return redis;
  }
  return null;
}
const mem = { [SEEN_KEY]: new Map<string, unknown>(), [PROBLEMS_KEY]: new Map<string, unknown>() };

async function all<T>(key: keyof typeof mem): Promise<T[]> {
  const r = client();
  if (!r) return [...mem[key].values()] as T[];
  return Object.values((await r.hgetall<Record<string, T>>(key)) ?? {});
}
async function one<T>(key: keyof typeof mem, id: string): Promise<T | null> {
  const r = client();
  if (!r) return (mem[key].get(id) as T | undefined) ?? null;
  return (await r.hget<T>(key, id)) ?? null;
}
async function put(key: keyof typeof mem, id: string, value: unknown): Promise<void> {
  const r = client();
  if (!r) return void mem[key].set(id, value);
  await r.hset(key, { [id]: value });
}
async function drop(key: keyof typeof mem, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const r = client();
  if (!r) return ids.forEach((id) => mem[key].delete(id));
  await r.hdel(key, ...ids);
}

export const listSeen = () => all<SeenTicket>(SEEN_KEY);
export const getSeen = (id: string) => one<SeenTicket>(SEEN_KEY, id);
export const saveSeen = (t: SeenTicket) => put(SEEN_KEY, t.id, t);
export const getProblem = (id: string) => one<Problem>(PROBLEMS_KEY, id);
export const saveProblem = (p: Problem) => put(PROBLEMS_KEY, p.id, p);

/** Forget tickets past the window, and problems none of whose tickets are still inside it. */
export async function pruneProblems(now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - PROBLEM_KEEP_DAYS * DAY_MS).toISOString();
  await drop(SEEN_KEY, (await listSeen()).filter((t) => t.at < cutoff).map((t) => t.id));
  await drop(
    PROBLEMS_KEY,
    (await all<Problem>(PROBLEMS_KEY)).filter((p) => p.tickets.every((t) => t.at < cutoff)).map((p) => p.id),
  );
}

/** For tests: forget everything. Memory store only. */
export function clearProblemsForTest(): void {
  mem[SEEN_KEY].clear();
  mem[PROBLEMS_KEY].clear();
}
