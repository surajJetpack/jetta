/**
 * Postgres client (Neon, provisioned through the Vercel Marketplace).
 *
 * Lazy, and null when DATABASE_URL is unset — the same contract as lib/kv.ts —
 * so builds, stub runs and environments without the database keep working and
 * every caller decides its own fallback (normally: read Freshdesk as before).
 */
import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema";

export type Db = NeonHttpDatabase<typeof schema>;

let db: Db | null = null;

export function getDb(): Db | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  db ??= drizzle(neon(url), { schema });
  return db;
}

export { schema };
