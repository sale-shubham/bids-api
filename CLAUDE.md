# CLAUDE.md — NobleBid API

REST API for NobleBid, an online auction platform (bidders, auctioneers, super admin).
Stack: Express 5 + TypeScript + Prisma 7 (adapter `@prisma/adapter-pg`, generated client in `src/generated/prisma/`) + PostgreSQL, deployed to AWS Lambda (ap-south-1) via `@codegenie/serverless-express` + Serverless v4. Package manager: `npm` (Node 24).

**Read first:** `.claude/RULES.md` (standing rules), `PROJECT_STRUCTURE.md`, `readme/ARCHITECTURE.md`.

Current state: feature-complete and merged into `dev`: email + password auth, members, uploads, auctions, bidding with anti-sniping, scheduled auction closing, notifications (email, in-app inbox, Web Push), live updates over WebSocket, commission payments via Razorpay, watchlist + ending-soon alerts, leaderboard, seller pages, admin API, contact, legal pages, public settings and sitemap. The `dev` stage is the live deployment at `https://bidsapi.shubsale.in` (app `https://bidsapp.shubsale.in`, website `https://noblebids.shubsale.in`, cookie domain `.shubsale.in`); no `prod` stage (branch `main`, `_PROD` names) is deployed yet. What is left is in `docs/GO-LIVE.md` (SES production access, Razorpay live keys, load test).

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

## Docs (README registry)

| Path | Covers |
|---|---|
| `AGENTS.md` | Agent / deployment notes, vendored skills |
| `PROJECT_STRUCTURE.md` | Current file layout |
| `readme/ARCHITECTURE.md` | Lambdas, request path, data, integrations |
| `readme/methods/*.md` | validation, prisma, security (env + rate limits), http, testing conventions |
| `docs/DOC_SYNC.md` | Which docs to update for which change |
| `docs/GO-LIVE.md` | Go-live checklist |
| `docs/DECISIONS.md` | History (old MERN app, P2X scaffold), product decisions D1–D8 (D7 domains decided), known limits |

Flow docs: `readme/flows/auth.md` (auth, members, uploads), `readme/flows/auctions.md` (auctions), `readme/flows/bidding.md` (bids, closing, anti-sniping), `readme/flows/notifications.md` (notify pipeline, in-app inbox), `readme/flows/payments.md` (commission payments), `readme/flows/websocket.md` (live updates), `readme/flows/watchlist.md`, `readme/flows/leaderboard.md`, `readme/flows/admin.md`, `readme/flows/legal-pages.md` (legal pages, public settings, contact), `readme/flows/deployment.md` (AWS, CI, env vars, domains).
