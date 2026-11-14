# Testing

Runner: **vitest** (`environment: node`). HTTP layer: **supertest** against `createApp()`. Coverage: `@vitest/coverage-v8`.

## Commands

| Command | What |
|---|---|
| `npm test` | all tests once (`vitest run`) |
| `npm run check` | `tsc --noEmit` + `npm test` (the gate; no build) |
| `npm run test:coverage` | tests + coverage, text table in the terminal and HTML in `coverage/index.html` (gitignored) |
| `npx vitest run src/__tests__/http/guards` | one file / name filter |

Coverage is report-only: `vitest.config.ts` sets no thresholds, so it never fails `check`. Never run a build to test anything.

## Layout

- `src/**/*.test.ts` next to the code: unit / service tests (mocked prisma, pure rules, middleware in isolation).
- `src/__tests__/http/*.http.test.ts`: black-box HTTP tests through the real Express app (routing, middleware order, guards, Joi schemas, controllers, error envelope, CORS, cookies).
  - `harness.ts` - shared setup (see below).
  - `guards.http.test.ts` - route matrix: unauthenticated -> 401, wrong role -> 403 (BIDDER vs seller/admin routes, AUCTIONEER vs bidder/admin routes), token / session / suspended-member cases, public routes stay public.
  - `validation.http.test.ts` - representative 400 `VALIDATION_ERROR`s per module (password rule, bid amount, auction time window, pagination bounds, admin settings ranges, contact, leaderboard, uploads, push).
  - `auth.http.test.ts` - signup -> verify -> login, cookie flags (httpOnly, SameSite, host-only, Secure/Domain variants), refresh and logout cookies.
  - `bidding.http.test.ts` - `POST /auctions/:id/bids` 201 shape and every mapped error code, anti-sniping, `GET /auctions` envelope (`meta`, `serverTime`), `GET /auctions/:id` 404.
  - `endpoints.http.test.ts` - Razorpay webhook (real HMAC over the raw body), commissions, ws tickets, public settings / legal / leaderboard / contact, watchlist, admin dashboard and settings.
  - `modules.http.test.ts` - uploads, push, members, notifications, admin lists / retention.
  - `envelope-cors.http.test.ts` - 404 `NOT_FOUND`, malformed JSON -> 400, 413, 500 without internals, security headers, CORS allow / deny / preflight.

## Mocking approach (HTTP tests)

Nothing touches a real DB, AWS, Razorpay or SES.

1. **Env**: `harness.ts` assigns the env vars `src/core/config/env.ts` reads (test JWT secrets, `COOKIE_DOMAIN=''` for host-only cookies, `CORS_ORIGINS`, Razorpay webhook secret, ...) at import time. Import it **first** in each test file. Each file runs in its own worker, so changing env in a file does not leak.
2. **Prisma**: `vi.mock('@/core/prisma/client', ...)` returns `prismaMock`, a deep proxy where `prisma.<model>.<method>` is a cached `vi.fn()`. Configure only what the request touches (`prismaMock.auction.findUnique.mockResolvedValue(null)`). `resetPrismaMock()` in `beforeEach` re-installs the defaults the guards need (session row for the token, active member, `$transaction` that runs the callback against the same double).
3. **Rate limiters**: `PgRateLimitStore` is replaced by `PassStore` (never limits, no DB). The limiters themselves stay mounted.
4. **Logger**: replaced by a silent stub (no pino-pretty worker, no noise on expected 500s).
5. **Auth**: tokens come from the real `signAccessToken` + the test secret: `await bearer('BIDDER' | 'AUCTIONEER' | 'SUPER_ADMIN', memberId)`. The session id is `s-<memberId>`, which the default session double accepts.
6. **Services/providers** are doubled only where the DB or an external system is the point: auth service (partial mock, `issueSession` and token signing stay real), notify queue, auction events, auction detail serializer, storage, email, push. Everything else (controllers, validation, error mapping such as bid rules) is real.
7. **Time**: `vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime(...)` - only `Date` is faked so supertest sockets still work. Restore with `vi.useRealTimers()` in `afterEach`.

## Adding a test

- New route: add it to the matrix in `guards.http.test.ts` (401 / 403 expectations) and a 400 case for its schema in `validation.http.test.ts`.
- New service-level behaviour: prefer a unit test beside the service; add an HTTP test only when routing, guards or the response envelope are part of the behaviour.
- Assert the envelope (`success`, `error.code`, `meta`) rather than only the status code. Do not weaken an assertion to make a test pass: fix the source.

## Known gaps / notes

- `watchlist/:auctionId` has no id-format schema; an unknown id is a 404 `AUCTION_NOT_FOUND` (covered).
- `cors` emits `Access-Control-Allow-Credentials` even for a disallowed origin; with no `Allow-Origin` the browser still blocks the response (covered as "no allow-origin").
- Not covered over HTTP: real SQL (no DB in tests), SES/S3/Razorpay network calls, the WebSocket server, SQS worker, scheduled jobs.
