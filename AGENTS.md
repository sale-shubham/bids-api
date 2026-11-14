# AGENTS.md — NobleBid API

## Project
`bids-api` — Express 5 + TypeScript + Prisma 7 + PostgreSQL on AWS Lambda (Serverless v4, ap-south-1).

## Agent rules
- Read `CLAUDE.md` first. Never run build commands; verify with `npm run check` (typecheck + vitest).
- Keep changes inside `src/modules/<name>/` following the routes/controller/service/validation split.
- `.claude/hooks/quality-gate.sh` runs `npm run typecheck` + `npm test` on session stop.
- `.claude/skills/` (readme-sync, ticket, webapp-testing, gh-env-sync) and `.claude/plugins/` are vendored helpers.

## Deployment
- `.github/workflows/pr_checks.yml`: `npm ci` -> `prisma generate` -> `npm run check`.
- `.github/workflows/deploy_serverless.yml`: branch `dev` -> stage dev, `main` -> stage prod; `prisma migrate deploy`, `npm run build:lambda`, `serverless deploy`; stack outputs go to the job summary. Full secret/variable table: `readme/flows/deployment.md`; sync them with `npm run env:sync`. Secrets (JWT, DB, Razorpay, VAPID private) come from GitHub `secrets.*`.
- Runtime env: pooled `DATABASE_URL`; `DIRECT_URL` only for migrations. Lambda env is declared in `serverless.yml`.
