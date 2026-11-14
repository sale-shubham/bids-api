# Architecture — NobleBid API

## Runtime
One Lambda (`index.handler`) serves three event shapes: EventBridge warmer ping, API Gateway WebSocket events (`$connect` / `$disconnect` / `$default` -> `src/modules/ws/ws.service.ts`), and HTTP API requests (serverless-express -> Express app in `src/app.ts`). A second function runs the daily retention purge. Locally `tsx index.js` starts a plain Express server.

## Request path
`app.ts` (helmet, CORS with credentials, JSON body with raw-body capture for the Razorpay webhook, cookie-parser) -> `routes.ts` -> module routes -> `authenticate` (JWT from `nb_at` cookie or Bearer, plus `Session` row lookup) -> `requireRole` / `requireActiveMember` -> Joi `validate` -> controller -> service -> Prisma.

## Data
PostgreSQL via Prisma 7 with the `pg` driver adapter. Runtime uses the pooled `DATABASE_URL`; migrations use `DIRECT_URL`. Phase 0 models: Member (BIDDER / AUCTIONEER / SUPER_ADMIN), Session, OtpChallenge, WsConnection, WsTicket, PushSubscription, RateLimitBucket, PaymentOrder, WebhookEvent, AppSetting. No migrations exist yet; Phase 1 adds Auction, Bid, Watchlist, Commission and the `init` migration.

## Integrations
- Email: SES (or stub) for OTP codes. Email OTP is used only for signup email verification and forgot-password; login is email + password.
- Payments: Razorpay one-time Orders API (stub driver for local dev). Webhook is HMAC-verified on the raw body and idempotent via `WebhookEvent`.
- Storage: S3 presigned PUT/GET, served through CloudFront.
- Realtime: API Gateway WebSocket (single-use ticket handshake) and Web Push (VAPID).
- Async: SQS `NotifyQueue` (+ `NotifyDLQ`); `NOTIFY_QUEUE_URL` empty locally means send inline.

## Deferred (later phases)
Email+password auth routes, auctions, bids, watchlist, commissions, scheduled auction jobs, flow docs.
