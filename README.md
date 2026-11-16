# Jetta

The AI support agent for Jetpack Apps and GetSign. She answers Freshdesk tickets, runs the chat widget on the websites and inside the monday apps, keeps the developers' boards and the customers' tickets in step, and gives the support team a console to supervise all of it.

Next.js (App Router) on Vercel, with Upstash Redis for state, Upstash Vector for retrieval and Neon Postgres for the ticket mirror.

## Where to read

| For | Read |
|---|---|
| How the system fits together: the request flow, each component, the endpoints | [JETTA-OVERVIEW.md](JETTA-OVERVIEW.md) |
| What changed and when, newest first | [docs/changelog.md](docs/changelog.md) |
| The chat widget: embedding, identity, limits | [docs/jettachat.md](docs/jettachat.md) |
| Using the console, for the support team | [docs/support-console-guide.md](docs/support-console-guide.md), [docs/manual](docs/manual) |
| Before writing Next.js code here | [AGENTS.md](AGENTS.md) — this version differs from older ones |

## Running it

```bash
npm ci
npm run dev
```

With no environment variables Jetta runs in **stub mode**: every integration returns canned data and nothing can reach a customer, a ticket or a board. Each integration goes live on its own switch (`FRESHDESK_LIVE`, `MONDAY_LIVE`, …), and anything that writes has a second one (`MONDAY_ALLOW_WRITES`, `FASTSPRING_ALLOW_WRITES`). `lib/config.ts` defines them all; `/system` in the console shows what is on in a deployment.

## Checks

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

`npm test` runs every `scripts/*-test` file that needs no keys, each in its own process, with stub mode forced and credentials stripped from the environment. A new `*-test` file is picked up automatically. The few that need a live service or a model are listed in `scripts/run-tests.mjs` and are run by hand with `--env-file=.env.local`.

CI runs the same four on every pull request and on `main` (`.github/workflows/ci.yml`). It has no secrets.

## Shipping

Merging to `main` deploys to production. Work on a branch, open a pull request, and add an entry at the top of `docs/changelog.md` for anything people would notice — the console assistant reads it.

Secrets a deployment must have, or the matching traffic is refused: `WEBHOOK_SECRET`, `CRON_SECRET`, `SLACK_SIGNING_SECRET`, and `CONSOLE_USERS` or `ADMIN_SECRET` (see `lib/request-auth.ts`).
