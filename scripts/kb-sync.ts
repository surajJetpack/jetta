/**
 * CLI for the KB site-sync engine (lib/kb-sync.ts) — same logic the daily
 * cron runs, for manual/dry runs:
 *
 *   npx tsx --env-file=.env.local scripts/kb-sync.ts [--site jetpackapps|getsign] [--dry-run]
 */
import { SITES, syncSite } from "../lib/kb-sync";

const DRY = process.argv.includes("--dry-run");
const siteArg = process.argv[process.argv.indexOf("--site") + 1];
const sites = process.argv.includes("--site") ? SITES.filter((s) => s.key === siteArg) : SITES;
if (!sites.length) {
  console.error(`unknown site "${siteArg}" — use jetpackapps or getsign`);
  process.exit(1);
}

async function main() {
  for (const site of sites) {
    console.log(`\n=== ${site.key} ${DRY ? "(DRY RUN)" : ""} ===`);
    const r = await syncSite(site, { dryRun: DRY });
    console.log(
      `crawled ${r.crawled} · +${r.created} new · ${r.updated} updated · ${r.archived} archived`,
    );
    if (r.skippedHumanEdited.length)
      console.log(`skipped (human-edited):\n  ${r.skippedHumanEdited.join("\n  ")}`);
    if (r.flagged.length) console.log(`FLAGGED: ${r.flagged.join("; ")}`);
  }
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
