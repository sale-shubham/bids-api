# Security

## Helmet

`helmet()` applied globally in `src/app.ts` with its defaults — sets secure HTTP headers (CSP, HSTS, X-Frame-Options, `X-Content-Type-Options: nosniff`, etc.) and removes `X-Powered-By`.

- The CSP is helmet's default policy (`default-src 'self'` plus helmet's stock directives) with no overrides: the API serves JSON only — there is no HTML route. Legal pages and auction descriptions are returned as sanitised HTML strings inside JSON, rendered by the web app.

## Trust proxy

`app.set('trust proxy', 1)` in `src/app.ts` — single proxy hop (API Gateway). Required so `req.ip` reflects the address that connected to API Gateway, which every per-IP rate limiter keys on.

- In the custom-domain deploy mode (a, live on the `dev` stage) of `readme/flows/deployment.md` the browser calls the API directly, so `req.ip` is the member's own IP.
- In the optional no-domain mode (b, not used by the live dev stage) the web app reaches the API through a Next.js rewrite, so requests come from the app's server and `req.ip` is that server's address. Every per-IP limiter (`authLimiter`, `otpIpLimiter`, `sensitiveLimiter`, `wsGuestLimiter`, `contactLimiter`, and the IP part of `otpLimiter`) then counts all members together. Prefer mode (a).

## CORS

`cors({ origin: env.corsOrigins, credentials: true, exposedHeaders: ['content-disposition'], maxAge: 7200 })` — `CORS_ORIGINS` env var, comma-separated list, exact-match per origin. In code it defaults to `http://localhost:3000`; on Lambda `serverless.yml` fills it from `APP_URL` when `CORS_ORIGINS` is unset. In deployed stages API Gateway answers CORS (`serverless.yml` `provider.httpApi.cors`, origins from `allowedOrigins`, a YAML list because Serverless v4 variables cannot split the comma string); it answers preflights itself and ignores Express's CORS headers, so this Express middleware is effectively for local dev. Every browser origin must be in `provider.httpApi.cors.allowedOrigins` AND `CORS_ORIGINS`. See `readme/flows/deployment.md`.

## Cookies

Built by `src/core/http/cookie-options.ts` (`buildCookieBase`): `httpOnly`, `path: '/'`, `SameSite` from `COOKIE_SAMESITE` (`lax` default, `none` forces `Secure`), `Secure` in production, `Domain` from `COOKIE_DOMAIN` (empty = host-only cookie, `.<domain>` for a shared parent domain; unset outside production = `localhost`).

| Cookie | Holds | Lifetime |
|---|---|---|
| `nb_at` | Access token | `maxAge` = `ACCESS_TTL_MS` (same string as the token's `expiresIn`) |
| `nb_rt` | Refresh token | `expires` = the refresh token's expiry; set at login / verify only, `refresh` never re-issues it |
| `dvid` | Device id for the `Session` row | 1 year; **not** cleared on `logout` / `logout-all` |

All three use `path: '/'` (the web app's middleware needs `nb_rt` on every page request to attempt a refresh).

## Rate limiting

`src/core/middleware/rateLimit.ts`

| Limiter | Applied to | Config | Store |
| --- | --- | --- | --- |
| `authLimiter` | `POST /auth/signup/verify`, `/auth/login`, `/auth/password/reset`, `/auth/password/change`, `/auth/2fa/*`, `POST /members/me/phone/verify` | 20 / 15 min per IP (`RATE_LIMIT_AUTH_MAX` overrides, dev only) | Postgres |
| `loginEmailLimiter` | `POST /auth/login` (after `authLimiter`) | 10 / 15 min per email, across all IPs — login brute-force guard | Postgres |
| `otpIpLimiter` | `POST /auth/signup`, `/auth/signup/resend`, `/auth/password/forgot`, `POST /members/me/phone/otp` | 20 / hour per IP across **all** emails (`RATE_LIMIT_OTP_IP_MAX` overrides, dev only) — stops one IP pumping OTP emails to many addresses | Postgres |
| `otpLimiter` | same routes (after `otpIpLimiter`) | 5 / hour, keyed by IP + email (trimmed, lower-cased) | Postgres |
| `sensitiveLimiter` | `POST /uploads/presign`, `POST /payouts/account` | 30 / 60 s per IP | Postgres |
| `bidAuctionLimiter` | `POST /auctions/:id/bids` | 10 / 10 s per member per auction | Postgres |
| `bidMemberLimiter` | `POST /auctions/:id/bids` (after `bidAuctionLimiter`) | 60 / 60 s per member | Postgres |
| `wsGuestLimiter` | `POST /ws/guest-ticket` | 30 / 60 s per IP | Postgres |
| `contactLimiter` | `POST /contact` | 5 / hour per IP (each message sends an email) | Postgres |
| `twoFactorLimiter` | `POST /auth/2fa/verify` (after `authLimiter`) | 5 / 10 min per member id from the verified challenge token (IP fallback) | Postgres (`rl:2fa:`) |
| `reportLimiter` | `POST /reports` | 20 / day per member (IP fallback) | Postgres (`rl:report:`) |
| `bulkLimiter` | `POST /auctions/bulk` | 5 / hour per member (IP fallback) | Postgres (`rl:bulk:`) |
| `qaLimiter` | `POST /auctions/:id/questions` | 10 / hour per member (IP fallback) | Postgres (`rl:qa:`) |
| `apiLimiter` | `POST /ws/ticket`, `POST /push/subscribe`, `POST /push/unsubscribe` | 60 / 60 s, keyed by `req.user?.sub` (falls back to per-IP) | in-memory |
| `auctionWriteLimiter` | `POST /auctions`, `PATCH /auctions/:id`, `POST /auctions/:id/republish` | 10 / 60 s per member (IP fallback) | in-memory |

- **Shared store for money/security limiters**: every limiter marked Postgres uses `PgRateLimitStore` (`src/core/middleware/pgRateLimitStore.ts`) — the `RateLimitBucket` table in the existing Postgres, one atomic upsert per hit, fixed window, each limiter under its own key prefix (`rl:auth:`, `rl:bid-member:`, …). Every Lambda container shares the count. A DB error fails open (`passOnStoreError`). No Redis/ElastiCache: those would need the Lambda in a VPC plus a NAT gateway; this costs nothing extra. Rows whose window ended more than a day ago are swept by the daily retention job (`purgeExpiredRateLimitBuckets`).
- **In-memory limiters** (`apiLimiter`, `auctionWriteLimiter`) count per container — cheap anti-hammering guards on ordinary writes, not money paths.
- **Keys**: limiters mounted after `authenticate` (bids, `apiLimiter`, `auctionWriteLimiter`) key by member id. Every custom `keyGenerator` keys the client IP as `ipKeyGenerator(req.ip ?? 'unknown')` (express-rate-limit's helper): IPv6 grouped by /56 subnet so one host can't rotate addresses past a limit, IPv4-mapped addresses unwrapped to IPv4. Never use raw `req.ip` in a keyGenerator — express-rate-limit v8 logs `ERR_ERL_KEY_GEN_IPV6` at startup when a keyGenerator mentions `req.ip` without calling `ipKeyGenerator` (guarded by `rateLimit.test.ts`). Limiters without a `keyGenerator` (`authLimiter`, `sensitiveLimiter`) use the library default, which does the same.
- **Order**: the auth limiters run before `validate()`, so an invalid body still counts against the limit. The email-keyed limiters normalise `req.body.email` themselves (trim + lower-case) so case variants can't dodge them.
- **Whole-API throttle** at API Gateway (`serverless.yml` `resources.extensions.HttpApiStage`): 50 req/s, burst 100 — past it API Gateway answers 429 before any Lambda runs. Not per client; it caps cost/load from a flood.
- **One entry point**: `httpApi.disableDefaultEndpoint` follows `DISABLE_DEFAULT_ENDPOINT` (default `false`). Set it to `true` only after the custom domain (`API_DOMAIN_NAME` + `API_CERTIFICATE_ARN`) works; the raw `execute-api` URL is then off and only the custom domain serves the API.
- **Abuse alarms** (only when GitHub var `ALERT_EMAIL` / `ALERT_EMAIL_PROD` is set): SNS email on >3000 API requests / 5 min and on >25 5xx / 5 min, scoped to this stack (an AWS Budget would be account-wide).
- Calling the API directly can't be prevented — it's public, and CORS only restrains browsers. Protection is auth on private routes + these limits.
- Every limiter returns the standard error envelope on 429: `{ success: false, error: { code: 'TOO_MANY_REQUESTS', message } }`.

## JWT

| Token         | Location                                                 | Expiry                                     |
| ------------- | -------------------------------------------------------- | ------------------------------------------ |
| Access token  | `Authorization: Bearer <token>` header / `nb_at` cookie | `ACCESS_TOKEN_EXPIRES_IN` (default `15m`)  |
| Refresh token | HttpOnly cookie `nb_rt`                                  | `REFRESH_TOKEN_EXPIRES_IN` (default `30d`) |

- Signed with `JWT_SECRET` (access) / `REFRESH_TOKEN_SECRET` (refresh), **algorithm pinned to `HS256`** on both sign and verify (`src/modules/auth/token.service.ts`).
- Cookie lifetimes are derived from the same `*_EXPIRES_IN` strings via `ms` (`ACCESS_TTL_MS` / `REFRESH_TTL_MS`), so no cookie outlives its token.
- Access token payload: `{ sub, role, sid }`; refresh token payload: `{ sub, sid }`. A 2FA challenge token (`{ typ: '2fa', sub, di? }`, 5 min, signed with `JWT_SECRET`) is accepted only by `/auth/2fa/verify`; `authenticate` rejects any token carrying `typ` or lacking `sid`.
- Verified in `authenticate` middleware (`src/core/middleware/auth.ts`); a Bearer header wins over the `nb_at` cookie. `optionalAuthenticate` (public routes whose answer depends on who asks, e.g. `GET /auctions/:id`, `GET /auctions/:id/bids`) treats a missing or bad token as anonymous instead of 401.
- **Session-backed, not fully stateless** — every access/refresh JWT carries a `sid` claim tied to a `Session` row (one per logged-in device). `authenticate` looks up that row on **every** request and 401s if it's gone or belongs to another member — so `logout` / `logout-all` / `DELETE /auth/sessions/:id` / eviction revoke a device's tokens immediately instead of waiting for natural expiry. `refresh` performs the same `Session` check, refuses a deactivated member (403 `ACCOUNT_SUSPENDED`) and then re-issues only the access token, so the refresh token keeps its login-time expiry (no sliding window).
- **Device cap**: logging in on a new device trims the member's other sessions to `limit - 1`, oldest (by `createdAt`) first, and force-closes their WebSockets (`session.service.ts` `upsertDeviceSession`). The limit is admin-configurable per role group at `PUT /admin/settings/device-limit` (`memberLimit` for BIDDER / AUCTIONEER, `superAdminLimit`, each 1-20, stored in `AppSetting` `device_limit_config`); until it is saved the default is `MAX_DEVICES_PER_MEMBER` = 3 (`src/core/config/constants.ts`).
- The `dvid` cookie identifies the browser for that `Session` row's `deviceId` — server-generated/reused (`device.service.ts`), never client-supplied, and kept across logout so a browser is recognised as the same device on its next login instead of consuming a fresh slot. It carries no auth privilege by itself — a request with a valid `dvid` but no valid access/refresh token is still anonymous.
- Password reset deletes every `Session` of the member; password change deletes every session except the current one. Deactivating a member (`PATCH /admin/members/:id`) deletes their sessions and closes their WebSockets.
- `requireRole(...roles)` gates seller routes (`AUCTIONEER`, `SUPER_ADMIN`), bidder routes (`BIDDER`) and every `/admin/*` route (`SUPER_ADMIN`). With `REQUIRE_ADMIN_2FA=true`, `requireRole('SUPER_ADMIN')` also reads `twoFactorEnabledAt` live and answers 403 `TWO_FACTOR_SETUP_REQUIRED` when it is null. `requireActiveMember` re-reads `isActive` live from the DB (not the JWT) so deactivation takes effect immediately, answering 403 `ACCOUNT_SUSPENDED`; it skips the lookup for `SUPER_ADMIN`.
- Login also refuses an unverified email (403 `EMAIL_NOT_VERIFIED`, and a verification code is sent unless one went out within the resend cooldown) and a deactivated account (403 `ACCOUNT_SUSPENDED`). Signup cannot pick `SUPER_ADMIN` (Joi allows only `BIDDER` / `AUCTIONEER`), and an admin cannot change their own role or deactivate themselves (409 `CANNOT_MODIFY_SELF`).

## Env vars (security-relevant)

| Variable | Purpose |
| --- | --- |
| `JWT_SECRET` | Access token signing |
| `REFRESH_TOKEN_SECRET` | Refresh token signing |
| `ACCESS_TOKEN_EXPIRES_IN` | Access token TTL (`ms` string, default `15m`), read in `token.service.ts` |
| `REFRESH_TOKEN_EXPIRES_IN` | Refresh token TTL (default `30d`), read in `token.service.ts` |
| `CORS_ORIGINS` | Allowed origins for Express (local dev; comma-separated, exact match). Deployed CORS comes from `provider.httpApi.cors.allowedOrigins` in `serverless.yml`; keep both in sync. Live: `https://bidsapp.shubsale.in` and `https://noblebids.shubsale.in` (website contact form) |
| `APP_URL` | Public app origin; auction/commission links in emails |
| `WEBSITE_URL` | Public marketing website origin; support `/contact` links in emails (default `APP_URL`) |
| `COOKIE_DOMAIN` | Cookie `Domain`: empty = host-only, live `.shubsale.in` (shared parent domain; also reaches unrelated `*.shubsale.in` sites) |
| `COOKIE_SAMESITE` | Cookie SameSite: `lax` (default) or `none` (forces Secure) |
| `PAYMENT_DRIVER` | `razorpay` or `stub` (default in code `stub`; `serverless.yml` defaults to `razorpay`) |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Razorpay API auth; the key secret also verifies the Checkout payment signature |
| `RAZORPAY_WEBHOOK_SECRET` | Webhook signature verification |
| `EMAIL_DRIVER` | `stub` (dev/test: logs the code, always issues `OTP_STUB_CODE`) or `ses` (real send via Amazon SES under the Lambda role). No boot guard on the value itself — the driver alone decides behaviour, in prod or dev. `OTP_DRIVER` is read into `env.otp.driver` but nothing uses it; the stub code depends on `EMAIL_DRIVER` only |
| `OTP_STUB_CODE` | Fixed code issued while `EMAIL_DRIVER=stub` (default `123456`) — dev/test only |
| `EMAIL_FROM` | SES sender; must be a verified identity (boot refuses the placeholder with `ses`) |
| `EMAIL_FROM_NAME` | Display name in the SES `From` header (`"${EMAIL_FROM_NAME} <${EMAIL_FROM}>"`), default `NobleBid` |
| `LOGO_URL` | Public HTTPS URL to the brand logo shown in the email header. Optional — falls back to a text wordmark when unset |
| `SMS_DRIVER` | `stub` (default: logs a masked number, and the code outside production) or `msg91` |
| `MSG91_AUTH_KEY` / `MSG91_SENDER_ID` / `MSG91_OTP_TEMPLATE_ID` | MSG91 Flow API credentials and DLT-registered OTP template (India). Auth key is a GitHub **secret**; boot refuses `msg91` in production without auth key and template id |
| `TOTP_ENC_KEY` | 32 bytes, base64 (`openssl rand -base64 32`): AES-256-GCM key for TOTP secrets. GitHub **secret**. Empty = 2FA setup / enable return 503 `TWO_FACTOR_UNAVAILABLE`. Rotating it invalidates every enrolled authenticator (members must re-enrol) |
| `REQUIRE_ADMIN_2FA` | `true` = Super Admins must enable 2FA before any `/admin` route works (default `false`) |
| `RATE_LIMIT_AUTH_MAX` / `RATE_LIMIT_OTP_IP_MAX` | Override the 20 / window caps of `authLimiter` / `otpIpLimiter`. Empty = 20. Set on the dev stage only (Playwright signs up many members from one CI IP); a non-number fails boot |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | Super Admin created by `npm run prisma:seed` when both are set. Remove the password from the environment after the first seed |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web Push signing pair. Optional — unset disables push only. The private key is a GitHub **secret**; never rotate the pair (it orphans every browser subscription). See `readme/flows/deployment.md` |
| `VAPID_SUBJECT` | `mailto:`/`https:` contact sent to push services, default `https://app.example.com` |

Flat, non-env-configurable values live in `src/core/config/constants.ts`, not `env.ts`: OTP TTL (600 s), length (6), resend cooldown (30 s) and the bootstrap device cap `MAX_DEVICES_PER_MEMBER` (3).

## Password hashing

- Member passwords are hashed with `bcryptjs`, cost 12 (`BCRYPT_COST` in `auth.service.ts`). Rule (`password.ts`, used for signup / reset / change): 8-72 **bytes** (bcrypt ignores anything past 72), at least one letter and one number. Login only checks presence, so the policy is not leaked.
- OTP codes are `bcrypt`-hashed (cost 10) into `OtpChallenge.otpHash`; the row also keeps the plaintext `code` so a resend within the TTL sends the same code. A challenge allows 5 attempts, then must be re-requested; the daily retention job deletes challenges 30 days past expiry.

## Two-factor auth and SMS

- TOTP (`src/core/security/totp.ts`): RFC 6238, SHA-1, 30 s step, 6 digits, +-1 step window, constant-work comparison with `crypto.timingSafeEqual`; base32 per RFC 4648. Secrets are generated with `crypto.randomBytes(20)`.
- Secret at rest (`src/core/security/secret-box.ts`): AES-256-GCM, random 12-byte IV, auth tag verified on decrypt (tampering or a wrong key throws). Key `TOTP_ENC_KEY`.
- Recovery codes: 10 per member, `XXXX-XXXX` from the base32 alphabet via `crypto.randomInt`, stored only as sha256 of the normalized code, single use (`usedAt` set by a guarded `updateMany`).
- Redaction: the pino logger censors `secret`, `totpSecret`, `totpSecretEnc`, `recoveryCode`, `recoveryCodes`, `challengeToken` (plus `pan`, `accountNumber`), at depth 0, 1 and 2 (`REDACT_PATHS`, tested in `logger.test.ts`).
- SMS: phone-verification OTP only (never login). The stub driver logs a masked number; the code is logged only outside production.

## Timing-safe comparisons

- Razorpay payment + webhook signature verification (`src/providers/payment/razorpay.payment.ts`, `safeEqualHex`) use `crypto.timingSafeEqual`, wrapped in try/catch so an attacker-controlled wrong-length signature fails closed (`false`) instead of throwing a `RangeError`/500. The webhook HMAC is computed over the raw request bytes (`req.rawBody`, captured by `express.json()`'s `verify` in `app.ts`).
- Login with an unknown email still runs `bcrypt.compare` against a dummy hash, so a miss costs the same time as a wrong password (no timing-based account enumeration). Signup resend and forgot-password answer the same whether or not the email exists.

## Payout data (PAN, bank account)

Seller onboarding (`POST /payouts/account`) forwards the PAN and the full bank account number to Razorpay and stores neither: `SellerPayoutAccount` keeps only the Razorpay ids, status, legal / beneficiary name, IFSC and the last 4 digits of the account. The pino logger redacts `pan` and `accountNumber` (`src/core/logger/logger.ts`), and the payouts code never logs request bodies. See `flows/payouts.md`.

## Uploads

`POST /uploads/presign` (authenticated, active member, `sensitiveLimiter`) mints a presigned S3 `PUT` URL valid for 60 s. The key is generated server-side (`<folder>/<uuid>-<timestamp><ext>`); `folder` is `auctions` or `avatars`; `contentType` must be `image/jpeg`, `image/png` or `image/webp`; `size` at most 5 MB. Both `ContentType` and `ContentLength` are signed into the URL, so S3 rejects a body of another type or size. Without `AWS_BUCKET_NAME` the route answers 503 `SERVICE_UNAVAILABLE`.

Auction `images` and a member's `avatarUrl` must start with this platform's media base (`AWS_CLOUDFRONT_URL` or the bucket's own S3 URL — `isOwnMediaUrl` in `members.service.ts`), so a member cannot point them at an arbitrary host. Uploads are not tracked in the database and there is no delete endpoint.

## Env fail-fast (boot-time validation)

`src/core/config/env.ts` refuses to boot when config is unsafe/incomplete:

- `DATABASE_URL` must be set (any environment).
- In production, JWT/refresh secrets must be present, ≥32 chars, not the dev defaults, **and differ from each other**.
- Storage is S3-only → `AWS_BUCKET_NAME` + `AWS_REGION` required in prod. In dev, `AWS_REGION` falls back to `ap-south-1` (not empty), so an unset region never silently stores member data outside India.
- `PAYMENT_DRIVER=razorpay` in prod → `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET` + `RAZORPAY_WEBHOOK_SECRET` required.
- `EMAIL_DRIVER=ses` in prod → `EMAIL_FROM` must be set and not left at its placeholder default (`noreply@example.com`), so a real send never fails on an unverified/example sender.
- Integer env vars (`int()`: `PORT`, `COMMISSION_RATE_BPS`, `RATE_LIMIT_*`) throw on non-numeric values instead of silently becoming `NaN`.

## Input validation

All user input passes through `validate(schema, source)` Joi middleware. `stripUnknown: true` removes unexpected fields before reaching the service layer. See `validation.md`.

- Web Push endpoints (`push.validation.ts`) accept **https URIs only** — an endpoint is a URL the API later POSTs to, so an `http://` or internal address would be a server-side request forgery a member could register.
- Rich text is sanitised server-side with `sanitize-html` allow-lists, never trusted from the client editor: auction descriptions (`sanitizeDescription` in `auctions.validation.ts`, applied in `auctions.service.ts`, which then requires 20 characters of allowed content) and legal pages (`sanitizeLegalHtml` in `legal-pages.sanitize.ts`). Allowed tags are `p br strong em u s ul ol li h2 h3 blockquote a`; links may only use `http`, `https` or `mailto` and get `rel="noopener noreferrer nofollow" target="_blank"`.
- Bid amounts and money fields are integer paise with explicit Joi bounds (e.g. `amountPaise` 1 to `HARD_MAX_PRICE_PAISE` = 1,000,000,000,000; the admin-set `auction.maxPricePaise` is checked in the service).

---

_Last updated: 2026-11-15 (rewritten against the NobleBid code: full limiter table from `rateLimit.ts`, cookie table with `path: '/'` for `nb_rt`, admin-configurable device cap, email + password hashing, presigned uploads, HTML sanitisers, env table aligned with `env.ts` / `.env.production.example`, `DISABLE_DEFAULT_ENDPOINT`, unused `OTP_DRIVER`)_
