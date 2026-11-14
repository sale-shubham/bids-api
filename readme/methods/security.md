# Security

## Helmet

`helmet()` applied globally in `src/app.ts` — sets secure HTTP headers (CSP, HSTS, X-Frame-Options, etc.).

- The global CSP is `default-src 'self'`, with no exceptions (the API serves JSON only — there is no HTML route).

## Trust proxy

`app.set('trust proxy', 1)` in `src/app.ts` — single proxy hop (API Gateway / ALB). Required so `req.ip` reflects the real client IP for per-IP rate limiting. Browsers (and the app's service worker) call this API directly, so that IP is the member's own.

### No forwarded client IP (removed 2026-11-03)

From 2026-09-24 the web app called this API through a same-origin `/api` proxy route, and a `trustedClientIp` middleware replaced `req.ip` with the browser IP the proxy sent in `x-nb-client-ip`, trusted only with `x-nb-proxy-secret` = `PROXY_SHARED_SECRET`. The app now calls the API directly everywhere, so the proxy, the middleware (and its test), `env.proxySharedSecret` and `PROXY_SHARED_SECRET` were removed. **Never put a server-side proxy in front of this API again without restoring something like it**: every request would carry the proxy's IP and all members would share one bucket in every per-IP limiter (`authLimiter` would lock everyone out after ~20 OTP verifies in 15 minutes). App side: the web app `readme/flows/api-connection.md`.

## CORS

`cors({ origin: env.corsOrigins, credentials: true, exposedHeaders: ['content-disposition'], maxAge: 7200 })` — `CORS_ORIGINS` env var, comma-separated list (falls back to `APP_URL`). Express owns CORS entirely: `serverless.yml` has no `httpApi.cors` because Serverless v4 variables cannot split the comma string into a list; the catch-all route forwards `OPTIONS` to the Lambda. Every deployed app origin must be in `CORS_ORIGINS`. Cookies: `COOKIE_DOMAIN` empty = host-only cookie, `.<domain>` for a shared parent domain; `COOKIE_SAMESITE` = `lax` (default) | `none` (forces Secure). See `readme/flows/deployment.md`.

## Rate limiting

`src/core/middleware/rateLimit.ts`

| Limiter            | Applied to                                     | Config                                                                           |
| ------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------- |
| `authLimiter`      | Auth endpoints (`otp/verify`, `signup/verify`) | Strict: 20 / 15 min                                                              |
| `auctionWriteLimiter` | `POST/PATCH /auctions`, `POST /auctions/:id/republish` | 10 / min per member (in-memory) |
| `otpIpLimiter`     | `otp/request`, `signup/start`, `signup/resend` | 20 / hour per IP across **all** identifiers — stops one IP pumping OTPs to many different numbers (`otpLimiter` alone is per IP+identifier) |
| `otpLimiter`       | `otp/request`                                  | SMS/email-cost-bearing: 5 / hour, keyed by identifier (mobile or email) + IP     |
| `signupLimiter`    | `signup/start`, `signup/resend`                | 5 / hour, keyed by ip+mobile+email+sessionId — a `start` call sends **two** OTPs |
| `gstOtpLimiter`    | GST portal OTP generate/verify                 | 5 / hour, keyed by gstin+IP                                                      |
| `sensitiveLimiter` | Sensitive endpoints (chat/RAG, leads, payments) | 30 / 60 s                                                                       |
| `apiLimiter`       | Ordinary authenticated write endpoints (e.g. `POST /messages/conversations/:id/messages`) | 60 / 60 s, keyed by `req.user?.sub` (falls back to per-IP) |

- **Shared store for money/security limiters**: `authLimiter`, `otpIpLimiter`, `otpLimiter`, `signupLimiter`, `gstOtpLimiter`, `sensitiveLimiter` use `PgRateLimitStore` (`src/core/middleware/pgRateLimitStore.ts`) — the `RateLimitBucket` table in the existing Postgres, one atomic upsert per hit, fixed window. Every Lambda container shares the count. A DB error fails open (`passOnStoreError`). No Redis/ElastiCache: those would need the Lambda in a VPC plus a NAT gateway (~$40/month); this costs nothing extra. Expired rows are swept by the daily retention job.
- **IP keys**: every custom `keyGenerator` keys the client IP as `ipKeyGenerator(req.ip ?? 'unknown')` (express-rate-limit's helper): IPv6 grouped by /56 subnet so one host can't rotate addresses past a limit, IPv4-mapped addresses unwrapped to IPv4. Never use raw `req.ip` in a keyGenerator — express-rate-limit v8 logs `ERR_ERL_KEY_GEN_IPV6` at startup when a keyGenerator mentions `req.ip` without calling `ipKeyGenerator` (guarded by `rateLimit.test.ts`). Limiters without a `keyGenerator` use the library default, which does the same.
- `apiLimiter` stays on the in-memory default store (per container) — it's a cheap anti-hammering guard on ordinary writes.
- **Whole-API throttle** at API Gateway (`serverless.yml` `resources.extensions.HttpApiStage`): 50 req/s, burst 100 — past it API Gateway answers 429 before any Lambda runs. Not per client; it caps cost/load from a flood.
- **One entry point**: `httpApi.disableDefaultEndpoint: true` turns off the raw `execute-api` URL; only the custom domain serves the API.
- **Abuse alarms** (only when GitHub var `ALERT_EMAIL` / `ALERT_EMAIL_PROD` is set): SNS email on >3000 API requests / 5 min and on >25 5xx / 5 min, scoped to this stack (an AWS Budget would be account-wide).
- Calling the API directly can't be prevented — it's public, and CORS only restrains browsers. Protection is auth on private routes + these limits.
- Both limiters return the standard error envelope on 429.

## JWT

| Token         | Location                                                 | Expiry                                     |
| ------------- | -------------------------------------------------------- | ------------------------------------------ |
| Access token  | `Authorization: Bearer <token>` header / `nb_at` cookie | `ACCESS_TOKEN_EXPIRES_IN` (default `15m`)  |
| Refresh token | HttpOnly cookie (`nb_rt`, path-scoped to `/auth`)       | `REFRESH_TOKEN_EXPIRES_IN` (default `30d`) |

- Signed with `JWT_SECRET` (access) / `REFRESH_TOKEN_SECRET` (refresh), **algorithm pinned to `HS256`** on both sign and verify.
- Signed access-token TTL (`15m`) matches the cookie `maxAge` (`ACCESS_TTL_MS`) — no token outliving its cookie.
- Verified in `authenticate` middleware (`src/core/middleware/auth.ts`). Both tokens are set as HttpOnly cookies (refresh path-scoped to `/auth`).
- **Session-backed, not fully stateless** — every access/refresh JWT carries a `sid` claim tied to a `Session` row (one per logged-in device, 1-device cap per Member as of 2026-09-12, was 2; see "Sessions & device limit" in `readme/flows/auth.md`). `authenticate` looks up that row on **every** request (one extra DB read per authenticated call, same pattern as `requireActiveMember` below) and 401s if it's gone — so `logout`/`logout-all`/eviction revoke a device's tokens immediately instead of waiting for natural expiry. `refresh` performs the same `Session` check before reissuing.
- A fourth cookie, `dvid` (httpOnly, 1yr `maxAge`), identifies the browser for that `Session` row's `deviceId` — server-generated/reused (`device.service.ts`), **not** cleared on `logout`/`logout-all` (deliberately, so a browser is recognized as the same device on its next login instead of consuming a fresh slot). It carries no auth privilege by itself — a request with a valid `dvid` but no valid access/refresh token is still anonymous.
- `requireRole(...roles)` gates admin routes; `requireActiveMember` re-reads `isActive` live from the DB (not the JWT claim) so deactivation takes effect immediately. There is no approval concept on Member — that lives on `Business` (`assertOwnedApprovedBusiness`).

## Env vars (security-relevant)

| Variable                   | Purpose                                                                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_SECRET`               | Access token signing                                                                                                                                |
| `REFRESH_TOKEN_SECRET`     | Refresh token signing                                                                                                                               |
| `ACCESS_TOKEN_EXPIRES_IN`  | Access token TTL                                                                                                                                    |
| `REFRESH_TOKEN_EXPIRES_IN` | Refresh token TTL                                                                                                                                   |
| `CORS_ORIGINS`             | Allowed origins                                                                                                                                     |
| `COOKIE_SAMESITE`             | Cookie SameSite: lax (default) or none |
| `RAZORPAY_WEBHOOK_SECRET`  | Webhook signature verification                                                                                                                      |
| `OTP_DRIVER`               | OTP delivery driver — `stub` (dev/test, fixed `OTP_STUB_CODE`) or `whatsapp` (real send via Meta WhatsApp Cloud API). No boot guard — the driver value alone decides behavior, in prod or dev |
| `OTP_STUB_CODE`            | Fixed code the stub driver always issues (default `123456`) — dev/test only                                                                         |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web Push signing pair (`readme/flows/push-notifications.md`). Optional — unset disables push only. The private key is a GitHub **secret**; never rotate the pair (it orphans every browser subscription) |
| `VAPID_SUBJECT`            | `mailto:`/`https:` contact sent to push services, default `https://app.example.com`                                                              |

Flat, non-env-configurable values (OTP TTL/length/resend-cooldown, signup session TTL, device cap, lead-unlock cost, default signup plan slug, buyer-pay tier catalog `Feature.key` values as `FEATURE_KEYS`) live in `src/core/config/constants.ts`, not `env.ts` — one file for every constant that never varies per-deployment.
| `EMAIL_DRIVER` | Email OTP delivery driver — `stub` (dev/test, fixed `OTP_STUB_CODE`) or `ses` (real send via Amazon SES). No boot guard — the driver value alone decides behavior, in prod or dev |
| `EMAIL_FROM_NAME` | Display name in the SES `From` header (`"${EMAIL_FROM_NAME} <${EMAIL_FROM}>"`), default `NobleBid` |
| `LOGO_URL` | Public HTTPS URL to the brand logo shown in the OTP email header. Optional — falls back to a text wordmark when unset |

## Password hashing

There are no passwords anywhere in this app — auth is mobile + OTP only (see `readme/flows/auth.md`). OTP codes are `bcrypt`-hashed (cost 10) before being stored on `OtpChallenge`.

## Timing-safe comparisons

`crypto.timingSafeEqual` used in:

- Razorpay payment + webhook signature verification (`src/providers/payment/razorpay.payment.ts`) — both wrapped in try/catch so an attacker-controlled wrong-length signature fails closed (`false`) instead of throwing a `RangeError`/500

## Upload ownership

Objects uploaded via `/uploads` are recorded in the `Upload` table (`memberId` + `storageKey`). `DELETE /uploads/:key` validates the key shape, then authorizes the caller as the owner or `SUPER_ADMIN` before deleting from storage — returns 404 (not 403) on miss to avoid key enumeration. See [readme/ARCHITECTURE.md](../ARCHITECTURE.md) storage section.

## Env fail-fast (boot-time validation)

`src/core/config/env.ts` refuses to boot in production when config is unsafe/incomplete:

- JWT/refresh secrets must be present, ≥32 chars, non-default, **and differ from each other**.
- Storage is S3-only → `AWS_BUCKET_NAME` + `AWS_REGION` required in prod. In dev, `AWS_REGION` falls back to `ap-south-1` (not empty) — DPDP Act §16, so an unset region never silently stores data outside India. See `readme/flows/data-processors.md`.
- `PAYMENT_DRIVER=razorpay` → `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET` + `RAZORPAY_WEBHOOK_SECRET` required.
- `EMAIL_DRIVER=ses` → `EMAIL_FROM` must not be left at its placeholder default (`noreply@example.com`) — refuses to boot otherwise, so a real send never fails on an unverified/example sender.
- Integer env vars (`int()`) throw on non-numeric values instead of silently becoming `NaN`.

## Input validation

Web Push endpoints (`push.validation.ts`) accept **https URIs only** — an endpoint is a URL the API later POSTs to, so an `http://` or internal address would be a server-side request forgery a member could register.

All user input passes through `validate(schema, source)` Joi middleware. `stripUnknown: true` removes unexpected fields before reaching service layer.

---

_Last updated: 2026-11-03 (`trustedClientIp` + `PROXY_SHARED_SECRET` removed with the web app's `/api` proxy; `req.ip` from `trust proxy` only)_
_Previously: 2026-11-03 (`VAPID_*` env vars; https-only Web Push endpoint validation)_
_Previously: 2026-10-22 (custom keyGenerators use express-rate-limit's `ipKeyGenerator` instead of the hand-rolled `ipKey`, fixing the v8 `ERR_ERL_KEY_GEN_IPV6` startup errors); 2026-10-19 (shared Postgres-backed store `PgRateLimitStore` for auth/OTP/signup/GST/sensitive limiters; new `otpIpLimiter` per-IP OTP cap across identifiers; API Gateway stage throttle; raw execute-api endpoint disabled; optional SNS abuse alarms; Swagger `/docs` removed entirely — it was an unused, Basic-Auth-only public map of every route)_
_Previously: 2026-09-11 (added `apiLimiter` — a general-purpose per-member (IP fallback) 60/min tier for ordinary authenticated writes that aren't costly/security-sensitive enough for `sensitiveLimiter`; first consumer is `POST /messages/conversations/:id/messages`, see [readme/flows/messaging.md](../flows/messaging.md))_
_Previously: 2026-07-24 (added `EMAIL_DRIVER=ses` real Amazon SES driver + `EMAIL_FROM_NAME` env var + boot guard requiring a non-placeholder `EMAIL_FROM` when SES is selected)_
_Previously: 2026-07-21 (JWT section: session-backed tokens via `Session` table + `sid` claim, per-request revocation check, 2-device cap; added `dvid` device-identity cookie, survives logout; consolidated flat constants (OTP TTL/length/resend-cooldown, signup TTL, device cap, lead-unlock cost) into `src/core/config/constants.ts`, removed from `env.ts`/serverless/`.env.production.example`)_

---
*Last updated: 2026-09-24 (new `trustedClientIp` middleware + `PROXY_SHARED_SECRET`: trust the web app's proxy client-IP header only with the shared secret, so per-IP rate limits stay per user behind the app's same-origin proxy)*
