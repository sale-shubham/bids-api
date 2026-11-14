# Project structure — bids-api (Phase 0)

```
bids-api/
├── index.js                  # Lambda handlers (api + WS + retention purge) and local dev server
├── serverless.yml            # service bids-api: HTTP API, WebSocket API, S3+CloudFront, NotifyQueue/NotifyDLQ, alarms
├── prisma/schema.prisma      # Member, Session, OtpChallenge, WsConnection, WsTicket, PushSubscription,
│                             #   RateLimitBucket, PaymentOrder, WebhookEvent, AppSetting
├── prisma.config.ts          # Prisma CLI config (DIRECT_URL)
├── scripts/build-lambda.mjs  # esbuild bundle (CI only)
├── src/
│   ├── app.ts                # helmet, cors, cookies, raw body for webhook, routes, error handlers
│   ├── routes.ts             # route mounting
│   ├── core/                 # config (env, constants), errors, http (cookies, pagination, params, response),
│   │                         #   logger, middleware (auth, rateLimit, validate, errorHandler), prisma client
│   ├── providers/            # email (SES + stub), payment (Razorpay + stub), storage (S3)
│   ├── templates/            # EJS email templates (otp-code)
│   └── modules/
│       ├── auth/             # token, session, device, otp-challenge, refresh/logout/sessions (signup/login: Phase 1)
│       ├── members/          # GET/PATCH /members/me
│       ├── uploads/          # presigned S3 PUT (uploads, auctions, avatars)
│       ├── push/             # Web Push subscribe/unsubscribe, sendPushToMember
│       ├── ws/               # WebSocket ticket + connect/disconnect, pushToMember
│       ├── settings/         # app settings, legal pages, device limit
│       ├── payments/         # Razorpay webhook (checkout/verify: Phase 1+)
│       └── admin/            # members, dashboard, retention, settings
├── readme/                   # ARCHITECTURE.md, methods/
├── docs/DOC_SYNC.md
└── .claude/ .husky/ .github/workflows/
```
