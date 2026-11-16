# Project structure — bids-api

```
bids-api/
├── index.js                  # Lambda handlers (api + WS, retentionPurge, closeAuctions, endingSoon, commissionReminder, salesMaintenance, riskScan, notifyWorker) and local dev server
├── serverless.yml            # service bids-api: HTTP API, WebSocket API, S3 (+ CloudFront when ENABLE_CDN=true), NotifyQueue/NotifyDLQ, closeAuctions (1 min) + endingSoon (15 min) + commissionReminder (1 day) + salesMaintenance (1 hour) + riskScan (1 day) + retentionPurge (1 day) + notifyWorker (SQS), alarms
├── prisma/schema.prisma      # Member, Session, OtpChallenge, Auction, Bid, MaxBid, Watchlist, Commission,
│                             #   WsConnection, WsTicket, PushSubscription, RateLimitBucket, PaymentOrder,
│                             #   WebhookEvent, Notification, AppSetting (+ migrations/, seed.ts, seed-demo.ts, seed-demo-clean.ts, demo-shared.ts)
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
│                             #   auction-unsold, reserve-not-met, ending-soon, commission-due, commission-paid, review-received, question-asked, question-answered, saved-search-match, contact-message + _head/_foot/_contact partials)
│   └── modules/
│       ├── auth/             # signup/verify/login/password flows, token, session, device, otp-challenge, password rule
│       ├── members/          # GET/PATCH /members/me, GET /members/:id/public, member.select.ts
│       ├── uploads/          # POST /uploads/presign (auctions, avatars: images 5 MB; auction-videos: mp4 / webm 50 MB; size + type signed into the PUT)
│       ├── auctions/         # catalogue, home, detail, create/patch/delete/republish, bulk create, mine, similar-sold; listing.rules (estimates, shipping, conditions)
│       ├── categories/       # GET /categories, GET /categories/:slug/stats; categories.rules (validateAttributes, tree, slugs), categories.service (resolution, stats, admin CRUD)
│       │                     #   (routes, controller, service, validation + sanitiser, serializer + effectiveStatus, query helpers)
│       │                     #   + bidding.rules.ts (pure: resolveMaxBid, reserveMet, validateBuyNow), auction-detail.service, auction-close.service, auction-events (WebSocket fan-out)
│       ├── bids/             # POST/GET /auctions/:id/bids (max bids), POST /auctions/:id/buy-now, GET /bids/mine
│       ├── notify/           # enqueueNotification (SQS or inline), processNotification, SQS worker, content
│       ├── notifications/    # in-app inbox: list, unread-count, read, read-all
│       ├── push/             # Web Push subscribe/unsubscribe, sendPushToMember
│       ├── ws/               # WebSocket: tickets, connect/default/disconnect, room + member fan-out, ws.transport (lambda|local driver), ws.local (dev server)
│       ├── settings/         # app settings (max-price.ts = admin price ceiling), legal pages, device limit
│       ├── commissions/      # GET /commissions/mine + /summary, POST /commissions/:id/checkout; markCommissionPaid, waiveCommission, runCommissionReminders
│       ├── sales/            # winner checkout: GET /sales/mine, /sales/:id, POST /sales/:id/checkout|ship|confirm|dispute; sales.rules, sales.jobs (runSalesMaintenance), markSalePaid, releaseSale
│       ├── payouts/          # GET|POST /payouts/account (Razorpay Route linked account; no PAN / full account number stored)
│       ├── payments/         # POST /payments/verify, POST /payments/webhook (Razorpay, HMAC + WebhookEvent dedupe)
│       ├── watchlist/        # GET /watchlist, /watchlist/ids, POST|DELETE /watchlist/:auctionId, runEndingSoon job
│       ├── reviews/          # POST /auctions/:id/review, POST /reviews/:id/reply, GET /members/:id/reviews; reviews.rules (ratingAvg, 60-day window)
│       ├── questions/        # GET|POST /auctions/:id/questions, POST /questions/:id/answer|hide
│       ├── saved-searches/   # GET|POST /saved-searches, DELETE /saved-searches/:id; saved-search.matcher (onAuctionPublished, notifyFollowers)
│       ├── follows/          # POST|DELETE /sellers/:id/follow, GET /members/me/following (follows.service)
│       ├── notification-preferences/ # GET|PUT /members/me/notification-preferences; catalogue in notify/notify.catalogue.ts
│       ├── analytics/        # POST /auctions/:id/view (recordView), GET /analytics/seller, /analytics/auctions/:id; analytics.rules (IST days, viewer key)
│       ├── featured/         # POST|GET /auctions/:id/feature(/checkout); featured.rules (featuredUntil math, prices), featured.service (checkout, markFeaturePaid); promoted feed lives in auctions.service
│       ├── referrals/        # referral codes, signup attach, qualification + reward (referrals.service, referrals.rules); GET /members/me/referral
│       ├── credits/          # MemberCredit ledger (credits.service: debit under row lock, admin adjust); GET /members/me/credits
│       ├── invoices/         # GST invoices: invoice.rules (FY, tax, words), invoices.service (issue, list, render + stream pdf), invoice.pdf (pdfkit), invoice.settings; /invoices, /admin/invoices
│       ├── deposits/         # POST /auctions/:id/deposit/checkout; deposits.rules (amounts, release decision), deposits.service (checkout, markDepositHeld), deposits.jobs (runDepositRelease)
│       ├── strikes/          # strikes.rules / service (unpaid-sale strikes, policy, suspendMember, admin list / remove)
│       ├── second-chance/    # /second-chance-offers (mine, :id, accept, decline); runner-up selection, offer DTO, expiry (POST /sales/:id/second-chance is in sales/)
│       ├── risk/             # shill-bid signals: risk.rules (scoring, scan), risk.service (checkBidRisk, upsertSignal), risk.jobs (runRiskScan)
│       ├── reports/          # POST /reports (reportLimiter), reports.service (target rules, admin notify)
│       ├── leaderboard/      # GET /leaderboard (spent|won)
│       ├── contact/          # POST /contact (rate limited, emails ADMIN_EMAIL with reply-to)
│       └── admin/            # dashboard, members (PATCH), auctions (+deposit), categories (CRUD), commissions (+waive), payments, sales (list, release, refund), reviews (list, hide), reports (queue, resolve), settings (+legal), retention, strikes (remove), risk (review queue)
├── readme/                   # ARCHITECTURE.md, methods/ (incl. pdf.md), flows/ (auth, reports, auctions, bidding, notifications, payments, checkout, deposits, strikes, risk, payouts, websocket, watchlist, reviews, questions, saved-searches, follows, notification-preferences, analytics, featured, referrals, invoices, leaderboard, admin, legal-pages, deployment)
├── docs/DOC_SYNC.md
└── .claude/ .husky/ .github/workflows/
```
