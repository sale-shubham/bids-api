# Project structure — bids-api

```
bids-api/
├── index.js                  # Lambda handlers (api + WS, retentionPurge, closeAuctions, endingSoon, commissionReminder, notifyWorker) and local dev server
├── serverless.yml            # service bids-api: HTTP API, WebSocket API, S3 (+ CloudFront when ENABLE_CDN=true), NotifyQueue/NotifyDLQ, closeAuctions (1 min) + endingSoon (15 min) + commissionReminder (1 day) + retentionPurge (1 day) + notifyWorker (SQS), alarms
├── prisma/schema.prisma      # Member, Session, OtpChallenge, Auction, Bid, Watchlist, Commission,
│                             #   WsConnection, WsTicket, PushSubscription, RateLimitBucket, PaymentOrder,
│                             #   WebhookEvent, Notification, AppSetting (+ migrations/, seed.ts, seed-demo.ts)
├── prisma.config.ts          # Prisma CLI config (DIRECT_URL)
├── scripts/build-lambda.mjs  # esbuild bundle (CI only)
├── scripts/run-close.ts      # npm run job:close, one-off auction close run
├── scripts/github-env-sync.mjs  # npm run env:sync: dotenv -> GitHub secrets/variables (+ .lib.mjs, .test.ts)
├── deploy/*.env.example      # per-stage env templates (real deploy/*.env is gitignored)
├── docs/GO-LIVE.md           # go-live checklist; readme/flows/deployment.md = deploy guide
├── src/
│   ├── app.ts                # helmet, cors, cookies, raw body for webhook, routes, error handlers
│   ├── routes.ts             # route mounting
│   ├── __tests__/http/       # supertest HTTP tests against createApp() (guards, validation, envelope, CORS); see readme/methods/testing.md
│   ├── core/                 # money.ts (toPaise, HARD_MAX_PRICE_PAISE), json-bigint.ts (BigInt JSON safety net), config (env, constants), errors, http (cookies, pagination, params, response),
│   │                         #   logger, middleware (auth, rateLimit, validate, errorHandler), prisma client
│   ├── providers/            # email (SES + stub, render.ts), payment (Razorpay + stub), storage (S3)
│   ├── templates/            # EJS email templates, HTML + .txt pairs (otp-code, welcome, outbid, auction-won, auction-sold,
│                             #   auction-unsold, ending-soon, commission-due, commission-paid, contact-message + _head/_foot/_contact partials)
│   └── modules/
│       ├── auth/             # signup/verify/login/password flows, token, session, device, otp-challenge, password rule
│       ├── members/          # GET/PATCH /members/me, GET /members/:id/public, member.select.ts
│       ├── uploads/          # POST /uploads/presign (auctions, avatars; images, 5 MB; size + type signed into the PUT)
│       ├── auctions/         # catalogue, home, categories, detail, create/patch/delete/republish, mine
│       │                     #   (routes, controller, service, validation + sanitiser, serializer + effectiveStatus, query helpers)
│       │                     #   + bidding.rules.ts (pure), auction-detail.service, auction-close.service, auction-events (WebSocket fan-out)
│       ├── bids/             # POST/GET /auctions/:id/bids, GET /bids/mine
│       ├── notify/           # enqueueNotification (SQS or inline), processNotification, SQS worker, content
│       ├── notifications/    # in-app inbox: list, unread-count, read, read-all
│       ├── push/             # Web Push subscribe/unsubscribe, sendPushToMember
│       ├── ws/               # WebSocket: tickets, connect/default/disconnect, room + member fan-out, ws.transport (lambda|local driver), ws.local (dev server)
│       ├── settings/         # app settings (max-price.ts = admin price ceiling), legal pages, device limit
│       ├── commissions/      # GET /commissions/mine + /summary, POST /commissions/:id/checkout; markCommissionPaid, waiveCommission, runCommissionReminders
│       ├── payments/         # POST /payments/verify, POST /payments/webhook (Razorpay, HMAC + WebhookEvent dedupe)
│       ├── watchlist/        # GET /watchlist, /watchlist/ids, POST|DELETE /watchlist/:auctionId, runEndingSoon job
│       ├── leaderboard/      # GET /leaderboard (spent|won)
│       ├── contact/          # POST /contact (rate limited, emails ADMIN_EMAIL with reply-to)
│       └── admin/            # dashboard, members (PATCH), auctions, commissions (+waive), payments, settings (+legal), retention
├── readme/                   # ARCHITECTURE.md, methods/, flows/ (auth, auctions, bidding, notifications, payments, websocket, watchlist, leaderboard, admin, legal-pages, deployment)
├── docs/DOC_SYNC.md
└── .claude/ .husky/ .github/workflows/
```
