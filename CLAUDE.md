# CLAUDE.md — NobleBid API

REST API for NobleBid, an online auction platform (bidders, auctioneers, super admin).
Stack: Express 5 + TypeScript + Prisma 7 (adapter `@prisma/adapter-pg`, generated client in `src/generated/prisma/`) + PostgreSQL, deployed to AWS Lambda (ap-south-1) via `@codegenie/serverless-express` + Serverless v4. Package manager: `npm` (Node 24).

Current state: **Phase 0 scaffold** — generic plumbing only. Auction / Bid / Watchlist / Commission models and email+password signup/login arrive in Phase 1+. Plan lives in `../plan/` (`02-bids-api.md`, `05-phases-checklist.md`).

## Rules

- **Never run a build** (`npm run build:lambda`, `esbuild`, `sls deploy`, `serverless package`). Verify with `npm run typecheck`, `npm test`, `npm run check` only. Builds run in CI.
- Never commit `.env` or secrets. `.env.production.example` is the variable list.
- Do not git commit/push unless asked.
- Update the docs listed in `docs/DOC_SYNC.md` in the same change as the code.

## Conventions

- Module layout: `src/modules/<name>/<name>.{routes,controller,service,validation}.ts`.
- Handlers lazy-load services/response helpers with dynamic `import()` (Lambda cold start).
- Validation with Joi via `validate(schema)`; errors via `AppError` helpers; responses via `ok` / `paginated`.
- Auth: httpOnly cookies `nb_at` / `nb_rt` (or `Authorization: Bearer`), JWT + `Session` row checked per request. Roles: `BIDDER`, `AUCTIONEER`, `SUPER_ADMIN`.
- Money is integer paise. Money paths are idempotent (`PaymentOrder.idempotencyKey`, `WebhookEvent`).
- Path alias `@/*` → `src/*`.

## Docs

| Path | Covers |
|---|---|
| `AGENTS.md` | Agent / deployment notes |
| `PROJECT_STRUCTURE.md` | Current file layout |
| `readme/ARCHITECTURE.md` | Architecture overview |
| `readme/methods/*.md` | validation, prisma, security, http conventions (partly carried over from the P2X codebase; sections that mention removed features are stale) |
| `docs/DOC_SYNC.md` | Which docs to update for which change |

Flow docs (`readme/flows/*`) are deferred.
