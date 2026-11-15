# Architecture — NobleBid API

## Runtime
`index.js` exports one handler per Lambda (wired in `serverless.yml`):

| Function | Trigger | Handler |
|---|---|---|
| `api` | HTTP API, WebSocket API, EventBridge warmer (`rate(5 minutes)`) | `handler`: warmer ping, API Gateway WebSocket events (`$connect` / `$disconnect` / `$default` -> `src/modules/ws/ws.service.ts`), or HTTP requests (serverless-express -> Express app in `src/app.ts`) |
| `closeAuctions` | `rate(1 minute)` | `closeAuctionsHandler`: starts SCHEDULED auctions, ends due ones, picks winner, creates commission |
| `endingSoon` | `rate(15 minutes)` | `endingSoonHandler`: watchlist "ending soon" alerts |
| `commissionReminder` | `rate(1 day)` | `commissionReminderHandler` |
| `salesMaintenance` | `rate(1 hour)` | `salesMaintenanceHandler`: cancels unpaid sales, auto-confirms shipped sales after 7 days and releases held funds, retries failed releases, strikes unpaid buyers, refunds / forfeits bid deposits, expires second-chance offers (`flows/checkout.md`, `flows/strikes.md`, `flows/deposits.md`) |
| `riskScan` | `rate(1 day)` | `riskScanHandler`: shill-bid concentration / never-wins scan of the last 90 days, upserts `ShillSignal` flags for admin review (`flows/risk.md`) |
| `retentionPurge` | `rate(1 day)` | `retentionPurgeHandler` |
| `notifyWorker` | SQS `NotifyQueue` (+ `NotifyDLQ`) | `notifyWorkerHandler`: email + push + WebSocket fan-out |

Locally `npm run dev` (`tsx watch index.js`) starts a plain Express server, attaches a local WebSocket server at `/ws` (`ws.local.ts`) when `WS_API_ENDPOINT` is empty, and replaces EventBridge with timers: auction close every 60 s, ending-soon every 5 min, commission reminders at startup and then every 6 h. `npm run job:close` runs one close pass by hand.

## Request path
`app.ts` (helmet, CORS with credentials, JSON body with raw-body capture for the Razorpay webhook, cookie-parser) -> `routes.ts` -> module routes -> `authenticate` / `optionalAuthenticate` (JWT from `nb_at` cookie or Bearer, plus `Session` row lookup) -> `requireRole` (with `REQUIRE_ADMIN_2FA`, also the Super Admin 2FA check) / `requireActiveMember` -> Joi `validate` -> controller -> service -> Prisma.

## Data
PostgreSQL via Prisma 7 with the `pg` driver adapter. Runtime uses the pooled `DATABASE_URL`; migrations use `DIRECT_URL`. Models: Member (BIDDER / AUCTIONEER / SUPER_ADMIN), Session, OtpChallenge, Auction, Bid, Watchlist, Commission, Notification, WsConnection, WsTicket, PushSubscription, RateLimitBucket, PaymentOrder, WebhookEvent, AppSetting, Sale, AuctionDeposit, Strike, SecondChanceOffer, ShillSignal. Migrations live in `prisma/migrations/`. `prisma/seed.ts` creates the Super Admin, default settings (commission rate, minimum increment, anti-sniping, categories) and legal pages; `prisma/seed-demo.ts` adds demo data. Money is always integer paise in `BigInt` columns, plain numbers in code and JSON (limits: `docs/DECISIONS.md` → Known limits).

The daily `retentionPurge` (also `POST /admin/retention/purge`) deletes OTP challenges expired more than 30 days, sessions idle longer than `max(30 days, refresh-token lifetime)` (`REFRESH_TTL_MS`; shill-bid detection reads 30 days of sessions), `WsTicket` rows expired or older than 1 day, `WsConnection` rows older than 2 h, and rate-limit buckets reset more than 1 day ago.

## Integrations
- Email: SES (or the stub driver) with EJS templates in `src/templates/`: otp-code, welcome, outbid, auction-won, auction-sold, auction-unsold, ending-soon, commission-due, commission-paid, review-received, question-asked, question-answered, saved-search-match, contact-message. Email OTP is used only for signup email verification and forgot-password; login is email + password.
- Payments: Razorpay Orders API called with `fetch` (no SDK), stub driver for local dev. Webhook is HMAC-verified on the raw body and idempotent via `WebhookEvent`. Razorpay Route (linked accounts, on-hold transfers, release, refund with reversal) is used for winner checkout: see `flows/checkout.md` and `flows/payouts.md`. See `flows/payments.md`.
- Storage: S3 presigned PUT for auction images and avatars. Served through CloudFront when `ENABLE_CDN=true`, otherwise straight from the bucket.
- Realtime: API Gateway WebSocket (single-use ticket handshake, guests allowed) and Web Push (VAPID). See `flows/websocket.md`.
- Async: SQS `NotifyQueue` (+ `NotifyDLQ`); `NOTIFY_QUEUE_URL` empty locally means send inline. See `flows/notifications.md`.

## Deployment
Serverless Framework v4, region ap-south-1, stages `dev` (branch `dev`) and `prod` (branch `main`). Guide: `flows/deployment.md`; go-live checklist: `docs/GO-LIVE.md`.
