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

- `src/**/*.test.ts` next to the code: unit / service tests (mocked prisma, pure rules such as `bidding.rules.test.ts`, feature suites `reviews/reviews.test.ts`, `questions/questions.test.ts`, `saved-searches/saved-searches.test.ts`, middleware in isolation, e.g. `auth.test.ts`, `errorHandler.test.ts`, `rateLimit.test.ts`).
- `scripts/**/*.test.ts`: tests for the repo scripts (`github-env-sync.test.ts`). Both globs are the `include` list in `vitest.config.ts`.
- `src/__tests__/http/*.http.test.ts`: black-box HTTP tests through the real Express app (routing, middleware order, guards, Joi schemas, controllers, error envelope, CORS, cookies).
  - `harness.ts` - shared setup (see below).
  - `guards.http.test.ts` - route matrix: unauthenticated -> 401, wrong role -> 403 (BIDDER vs seller/admin routes, AUCTIONEER vs bidder/admin routes), token / session / suspended-member cases, public routes stay public.
  - `validation.http.test.ts` - representative 400 `VALIDATION_ERROR`s per module (password rule, bid amount, auction time window and images, pagination bounds, admin settings / device-limit / legal-page / member-update / retention ranges, contact, leaderboard, commissions, members, uploads, push).
  - `auth.http.test.ts` - signup -> verify -> login, cookie flags (httpOnly, SameSite, host-only, Secure/Domain variants), refresh and logout cookies.
  - `bidding.http.test.ts` - `POST /auctions/:id/bids` (max bids, `amountPaise` alias, proxy rows and events, `outbidByProxy`) 201 shape and every mapped error code, `POST /auctions/:id/buy-now`, reserve / buy-now create rules, anti-sniping, `GET /auctions` envelope (`meta`, `serverTime`), `GET /auctions/:id` 404.
  - `endpoints.http.test.ts` - Razorpay webhook (real HMAC over the raw body), commissions, ws tickets, public settings / legal / leaderboard / contact, watchlist, admin dashboard and settings.
  - `modules.http.test.ts` - uploads, push, members, notifications, admin lists / retention.
  - `envelope-cors.http.test.ts` - 404 `NOT_FOUND`, malformed JSON -> 400, 413, 500 without internals, security headers, CORS allow / deny / preflight.

## Mocking approach (HTTP tests)

Nothing touches a real DB, AWS, Razorpay or SES.

1. **Env**: `harness.ts` assigns the env vars `src/core/config/env.ts` reads (test JWT secrets, `COOKIE_DOMAIN=''` for host-only cookies, two `CORS_ORIGINS`, `PAYMENT_DRIVER=razorpay` with a test webhook secret so the HMAC check is real, `EMAIL_DRIVER=stub`, a test bucket and CloudFront URL so platform-upload URL checks work, ...) at import time. Import it **first** in each test file. Each file runs in its own worker, so changing env in a file does not leak.
2. **Prisma**: `vi.mock('@/core/prisma/client', ...)` returns `prismaMock`, a deep proxy where `prisma.<model>.<method>` is a cached `vi.fn()`. Configure only what the request touches (`prismaMock.auction.findUnique.mockResolvedValue(null)`). `resetPrismaMock()` in `beforeEach` re-installs the defaults the guards need (session row for the token, active member, `$transaction` that runs the callback against the same double).
3. **Rate limiters**: `PgRateLimitStore` is replaced by `PassStore` (never limits, no DB). The limiters themselves stay mounted.
4. **Logger**: replaced by a silent stub (no pino-pretty worker, no noise on expected 500s).
5. **Auth**: tokens come from the real `signAccessToken` + the test secret: `await bearer('BIDDER' | 'AUCTIONEER' | 'SUPER_ADMIN', memberId)` (header value) or `await tokenFor(role, memberId)` (raw token, e.g. for the `nb_at` cookie). The session id is `s-<memberId>`, which the default session double accepts.
6. **Services/providers** are doubled only where the DB or an external system is the point, as partial mocks (`vi.mock(path, async (orig) => ({ ...(await orig()), ...doubles }))`) where possible: auth service (`signup` / `verifySignup` / `login` / `refresh`; `issueSession`, cookies and token signing stay real), `session.service` `upsertDeviceSession`, `members.service` `getMemberDto`, notify queue, auction events, `auction-detail.service` (`buildAuctionDetail`), `auctions.service` `listAuctions` (to assert the parsed query), storage, email, push service, admin retention service. Everything else (controllers, validation, error mapping such as bid rules) is real.
7. **Time**: `vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime(...)` - only `Date` is faked so supertest sockets still work. Restore with `vi.useRealTimers()` in `afterEach`.

## Adding a test

- New route: add it to the matrix in `guards.http.test.ts` (401 / 403 expectations) and a 400 case for its schema in `validation.http.test.ts`.
- New service-level behaviour: prefer a unit test beside the service; add an HTTP test only when routing, guards or the response envelope are part of the behaviour.
- Assert the envelope (`success`, `error.code`, `meta`) rather than only the status code. Do not weaken an assertion to make a test pass: fix the source.

## Known gaps / notes

- `watchlist/:auctionId` has no id-format schema; an unknown id is a 404 `AUCTION_NOT_FOUND` (covered).
- `cors` emits `Access-Control-Allow-Credentials` even for a disallowed origin; with no `Allow-Origin` the browser still blocks the response (covered as "no allow-origin").
- Not covered over HTTP: real SQL (no DB in tests), SES/S3/Razorpay network calls, the WebSocket server, SQS worker, scheduled jobs. The last three have unit tests with mocked prisma instead: `ws.test.ts` (tickets, messages, fan-out, local adapter), `notify.test.ts` (`processNotification`, `processSqsBatch`), `auction-close.service.test.ts` (`runAuctionClose`), `watchlist.service.test.ts` (`runEndingSoon`), `commissions.service.test.ts` (`runCommissionReminders`), `sales/sales.test.ts` (`runSalesMaintenance`). Checkout suites: `sales/sales.test.ts`, `payouts/payouts.test.ts`, `providers/payment/payment.provider.test.ts` (Razorpay driver with a mocked `fetch`, stub driver).
