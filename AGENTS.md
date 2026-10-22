<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Keep the console assistant's knowledge current

Jetta's console assistant (⌘J) knows only what it reads at the start of each session: the /system rows (`lib/system-status.ts`), the manual (`docs/manual/README.md`, `docs/manual/general.md`), `JETTA-OVERVIEW.md` and the newest entries of `docs/changelog.md`. A change that skips them ships a feature the assistant will deny or explain wrongly. So any change that alters what Jetta does, or what people see, includes in the SAME PR:

1. **A `docs/changelog.md` entry** at the top: `## YYYY-MM-DD: title (#PR)`, then 2–4 plain lines on what changed, the switch that controls it, and whether it is live.
2. **A /system row** for every new switch or write gate (`lib/system-status.ts`), and a `CRONS` row for every new cron.
3. **The manual**, where the behaviour is explained. If the change contradicts a rule the manual states, rewrite that rule; a new paragraph next to an old rule loses to the rule.
4. **`JETTA-OVERVIEW.md`** when a component, tool or pipeline step is added.

`npm run build` runs `scripts/check-assistant-knowledge.mjs` first and fails if a switch or cron is undocumented or the changelog is malformed. It cannot check that the prose is right; you have to.
