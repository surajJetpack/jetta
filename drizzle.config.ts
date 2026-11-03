import { defineConfig } from "drizzle-kit";

// Run with the env loaded, e.g. `npx dotenv -e .env.local -- npx drizzle-kit migrate`
// or `node --env-file=.env.local node_modules/.bin/drizzle-kit migrate`.
export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
