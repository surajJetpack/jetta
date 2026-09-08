/**
 * CLI for the KB site-sync engine (lib/kb-sync.ts) — same logic the daily
 * cron runs, for manual/dry runs:
 *
 *   npx tsx --env-file=.env.local scripts/kb-sync.ts [--site jetpackapps|getsign] [--dry-run]
 *
 * --allow-bulk overrides the mass-creation guard, for when a large batch of new
 * pages has been eyeballed and genuinely belongs in the KB. The cron never
 * passes it: an unattended run must not be able to flood the retrieval corpus.
 */
import { SITES, syncSite } from "../lib/kb-sync";

const DRY = process.argv.includes("--dry-run");
const ALLOW_BULK = process.argv.includes("--allow-bulk");
const siteArg = process.argv[process.argv.indexOf("--site") + 1];
const sites = process.argv.includes("--site") ? SITES.filter((s) => s.key === siteArg) : SITES;
if (!sites.length) {
  console.error(`unknown site "${siteArg}" — use jetpackapps or getsign`);
  process.exit(1);
}

async function main() {
  for (const site of sites) {
    console.log(`\n=== ${site.key} ${DRY ? "(DRY RUN)" : ""} ===`);
    const r = await syncSite(site, { dryRun: DRY, allowBulk: ALLOW_BULK });
    console.log(
      `crawled ${r.crawled} · +${r.created} new · ${r.updated} updated · ${r.archived} archived` +
        (r.skippedNew ? ` · ${r.skippedNew} new HELD BACK by the creation guard` : ""),
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
