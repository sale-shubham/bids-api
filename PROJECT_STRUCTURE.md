# Project structure — bids-api (Phase 1: auth)

```
bids-api/
├── index.js                  # Lambda handlers (api + WS + retention purge) and local dev server
├── serverless.yml            # service bids-api: HTTP API, WebSocket API, S3+CloudFront, NotifyQueue/NotifyDLQ, alarms
├── prisma/schema.prisma      # Member, Session, OtpChallenge, Auction, Bid, Watchlist, Commission,
│                             #   WsConnection, WsTicket, PushSubscription, RateLimitBucket, PaymentOrder,
│                             #   WebhookEvent, AppSetting (+ migrations/, seed.ts)
├── prisma.config.ts          # Prisma CLI config (DIRECT_URL)
├── scripts/build-lambda.mjs  # esbuild bundle (CI only)
├── src/
│   ├── app.ts                # helmet, cors, cookies, raw body for webhook, routes, error handlers
│   ├── routes.ts             # route mounting
│   ├── core/                 # config (env, constants), errors, http (cookies, pagination, params, response),
│   │                         #   logger, middleware (auth, rateLimit, validate, errorHandler), prisma client
│   ├── providers/            # email (SES + stub, render.ts), payment (Razorpay + stub), storage (S3)
│   ├── templates/            # EJS email templates, HTML + .txt pairs (otp-code, welcome)
│   └── modules/
│       ├── auth/             # signup/verify/login/password flows, token, session, device, otp-challenge, password rule
│       ├── members/          # GET/PATCH /members/me, GET /members/:id/public, member.select.ts
│       ├── uploads/          # POST /uploads/presign (auctions, avatars; images, 5 MB)
│       ├── push/             # Web Push subscribe/unsubscribe, sendPushToMember
│       ├── ws/               # WebSocket ticket + connect/disconnect, pushToMember
│       ├── settings/         # app settings, legal pages, device limit
│       ├── payments/         # Razorpay webhook (checkout/verify: Phase 1+)
│       └── admin/            # members, dashboard, retention, settings
├── readme/                   # ARCHITECTURE.md, methods/, flows/auth.md
├── docs/DOC_SYNC.md
└── .claude/ .husky/ .github/workflows/
```
