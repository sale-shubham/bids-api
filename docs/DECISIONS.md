# NobleBid v2 — history and decisions

Covers both repos (`bids-api`, `bids-app`). Code wins over this file when they disagree.

## History

- NobleBid v2 rebuilds the original NobleBid auction app, a MERN project kept at `D:\Shubham\projects\noble_bids-main`. That codebase is a feature reference only. It still holds the original logo master (`attached_assets/logo-*.png`, larger than the 192 px `bids-app/public/brand/logo-source.png`) and the old placeholder images (`Frontend/public/{auctionEnded.png,notStarted.png,imageHolder.jpg}`).
- Both repos were scaffolded from the P2X project at `D:\Aialphatech\p2x` (`p2x_api` became `bids-api`, `p2x_app` became `bids-app`). That is why some patterns and helpers look generic.

## What changed from the old app

| Old (MERN) | New |
|---|---|
| MongoDB + Mongoose, bids stored inside the auction document | PostgreSQL + Prisma, own `Bid` table, money as integer paise |
| Username + password | Email + password (bcrypt) with email OTP verification |
| Cloudinary images | S3 presigned upload (+ optional CloudFront) |
| Nodemailer Gmail SMTP, EmailJS contact form | AWS SES from the backend |
| `node-cron` in the server process | EventBridge scheduled Lambdas |
| Bid updates only on refresh | Live updates over API Gateway WebSocket |
| Commission paid offline, proof upload, admin approval | Commission paid with Razorpay, confirmed by verify + webhook |
| Render (backend) + Netlify (frontend) | AWS Lambda + AWS Amplify |
| React + Vite SPA | Next.js PWA with server-rendered public pages |

Kept from the old app: three roles (Bidder, Auctioneer, Super Admin), 5% commission on the final bid owed by the auctioneer, auctioneer blocked from creating auctions while commission is unpaid, watchlist, leaderboard, recently viewed, featured / ending soon / upcoming sections, share buttons, admin dashboard with charts.

## Decisions

| # | Decision | Chosen | Rejected (and why) |
|---|---|---|---|
| D1 | Login | Email + password; email OTP only for signup verification and forgot password | Passwordless email OTP; mobile OTP over WhatsApp |
| D2 | Payment model | Auctioneer pays the 5% commission through Razorpay Checkout + webhook | Winner pays the platform with Razorpay Route payouts (possible later); keeping manual proof upload |
| D3 | App state | zustand (client state) + TanStack Query (server data) | Redux |
| D4 | Postgres host | Managed Postgres with a pooled URL for Lambda (`DATABASE_URL`) and a direct URL for migrations (`DIRECT_URL`) | AWS RDS + RDS Proxy: Lambda would need a VPC plus VPC endpoints for SES / S3 / SQS, at higher cost |
| D5 | Roles | Role chosen at signup (Bidder or Auctioneer); Super Admin from the seed script | Every member can both buy and sell |
| D6 | Guests | Guests can open an auction and receive live bid updates; bidding needs login | Live updates only for logged-in users |
| D7 | Domains | Decided 2026-11-15, live. The `dev` stage (stack `bids-api-dev`) is the live deployment: website `https://noblebids.shubsale.in`, app `https://bidsapp.shubsale.in`, API `https://bidsapi.shubsale.in` (ACM cert + Route 53 record to `CustomDomainTarget`, ap-south-1), cookie domain `.shubsale.in` (the whole registrable domain, chosen by the owner). A `prod` stage (branch `main`, `_PROD` names) is not deployed yet and is an optional future stage | Dev-specific subdomains; the narrower `.noblebids.shubsale.in` cookie scope; no-domain (proxy) mode as the live setup |
| D8 | AWS region | `ap-south-1` (Mumbai) | — |
| D9 | Bidding model | Every bid is a max bid (eBay model, proxy bidding via `MaxBid`); the reserve is hidden, only met / not met is shown; Buy It Now disappears after the first bid; relisting after reserve-not-met is a client pre-fill of `/sell/new`, no endpoint | Fixed-amount bids; a visible reserve; a relist endpoint |
| D10 | Winner checkout (supersedes D2 when `checkout.mode` is not `off`) | The winner pays the platform in-app through Razorpay Route: the order carries an on-hold transfer to the seller's linked account (amount minus commission); funds are held until the buyer confirms delivery or 7 days after shipping, then released; disputes are resolved by an admin (release or refund). Sellers without an ACTIVE payout account (or mode `off`) keep the D2 commission flow. Modes: `off`, `optional` (default), `required` (sellers must have a payout account to list) | Seller-paid commission only (D2: no buyer protection, commission collection risk); paying the seller directly with a platform fee (no hold, no refund leverage) |
| D11 | Trust and safety (phase D) | Two-factor auth is TOTP (RFC 6238 authenticator app + recovery codes, secrets encrypted with `TOTP_ENC_KEY`), optional for members and enforceable for Super Admins (`REQUIRE_ADMIN_2FA`); SMS is used only for phone verification (MSG91, DLT template), never as a login factor; a seller is "verified" = KYC'd payout account (ACTIVE) + verified phone, with an admin revoke; members report auctions / members / reviews / questions into an admin moderation queue (actions reuse existing endpoints) | SMS or email OTP as the second factor (SIM-swap exposure, per-message cost); verification by document upload; auto-moderation |
| D12 | Deposits, strikes, second chance, shill signals (phase E) | **Deposits:** a refundable Razorpay deposit (no Route transfer) is required to bid on auctions whose starting bid reaches `auction.depositThresholdPaise` (default Rs 1 lakh, 10% = `auction.depositRateBps`; threshold 0 turns it off) and, regardless of price, from a member's 2nd active strike; it is refunded when the auction ends and the member did not win, once the winner has paid, on cancellation and in legacy mode, and forfeited when the winner's sale is cancelled for non-payment. **Strikes:** an unpaid sale cancelled by the job gives the buyer a strike valid 12 months (1 warns, 2 requires deposits, 3 suspends the account); admins can remove a strike but unsuspend separately. **Second chance:** after a cancellation the seller may offer the item to the runner-up at the runner-up's own maximum bid (not the cancelled price), valid 48 hours, creating a fresh sale if accepted; one open sale per auction is enforced by a partial unique index. **Shill signals** (shared device / IP with the seller, new single-seller accounts, bid concentration, never winning) only create flags for admin review: nothing is blocked or cancelled automatically | Fixed-rupee deposits (do not scale with price); forfeiting to the seller (an incentive for sellers to cancel); offering the cancelled price to the runner-up (they never agreed to it); auto-blocking on a shill score (false positives hurt real bidders) |

D7 constraint: app and API must share one parent domain, because the `nb_at` / `nb_rt` cookies set by `bidsapi.shubsale.in` (with `COOKIE_DOMAIN=.shubsale.in`) must also reach `bidsapp.shubsale.in`, where the edge gate `bids-app/src/proxy.ts` reads `nb_at`. The marketing website (`bids-website`, `https://noblebids.shubsale.in`) is a separate site; it only calls `POST /contact` cross-origin, so its origin must be in `provider.httpApi.cors.allowedOrigins` (serverless.yml, API Gateway CORS) and `CORS_ORIGINS` (Express, local dev), and email support links use `WEBSITE_URL`. Both lists include the website (`CORS_ORIGINS` since 2026-11-15); `WEBSITE_URL` is set as a GitHub variable since 2026-11-15 and takes effect on the first deploy that includes the `WEBSITE_URL` code.

Cookie scope `.shubsale.in`: `shubsale.in` also hosts unrelated sites (`meetsync.shubsale.in`, `www.shubsale.in`, `api.shubsale.in`, and others), and the browser sends `nb_at` / `nb_rt` to every `*.shubsale.in` host, not only NobleBid's. No other app there may use the cookie names `nb_at` / `nb_rt` (a second cookie with the same name would shadow or overwrite NobleBid's), and no untrusted site may be hosted under `shubsale.in`. Narrowing later means choosing a narrower `COOKIE_DOMAIN` (for example `.bidsapp.shubsale.in` only works if the API is moved under it) and redeploying; members then log in once more.

Live setup and the optional prod stage: the `dev` stage is what is deployed and serves production traffic through the custom domains above, with GitHub variables under their plain (non-`_PROD`) names (`APP_URL`, `CORS_ORIGINS`, `COOKIE_DOMAIN`, `API_DOMAIN_NAME`). The `prod` stage (branch `main`, `_PROD` names) has not been deployed. If it is added later, it needs its own hostnames and a cookie scope that does not collide with the dev stage's `.shubsale.in` cookies, because two stages sharing one parent domain would share or shadow `nb_at` / `nb_rt`. No-domain (proxy) mode, where the API is reached through the app's Next.js `/api` rewrite with a host-only cookie, remains a supported option but is not what dev uses. Steps: `docs/GO-LIVE.md` §3.

## Known limits

- Every paise column is Postgres `BigInt` (int8; migration `20261115170000_paise_bigint`). Prisma returns `bigint`; application code, JSON, WebSocket payloads, notification data and payment-provider amounts stay plain `number`, converted at the boundary with `toPaise()` (`src/core/money.ts`), so the contract is exact up to 2^53 paise. `HARD_MAX_PRICE_PAISE` = 1,000,000,000,000 (₹1,000 crore) is the Joi cap for bids, starting bid and minimum increment. A lower, admin-set ceiling `auction.maxPricePaise` (default 10,000,000,000 = ₹10 crore, allowed 100,000 to `HARD_MAX_PRICE_PAISE`) is enforced in `createAuction`, `updateAuction` and `placeBid` (400 `PRICE_TOO_HIGH`). A `BigInt.prototype.toJSON` safety net (`src/core/json-bigint.ts`) only prevents crashes on a stray `bigint`.
- Uploaded images are not resized or compressed on the client.
