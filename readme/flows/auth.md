# Auth flow (email + password)

Email + password (bcryptjs, cost 12). Email OTP is used only to verify the email at signup and for forgot-password. Auth = httpOnly cookies `nb_at` (access) / `nb_rt` (refresh) or `Authorization: Bearer`. Success envelope `{ success: true, data }`; errors `{ success: false, error: { code, message, details? } }`.

Code: `src/modules/auth/*`, `src/modules/members/*`, `src/modules/uploads/*`, `src/providers/email/*`, `src/templates/*`.

## Endpoints

| Method | Path | Auth | Body -> response |
|---|---|---|---|
| POST | `/auth/signup` | public | `{ name, email, password, role: BIDDER\|AUCTIONEER }` -> 201 `{ email, resendAfterSec }` |
| POST | `/auth/signup/verify` | public | `{ email, code }` -> cookies + `{ member }`; welcome email |
| POST | `/auth/signup/resend` | public | `{ email }` -> `{ resendAfterSec }` (429 inside cooldown, `details.resendAfterSec`) |
| POST | `/auth/login` | public | `{ email, password }` -> cookies + `{ member }` |
| POST | `/auth/password/forgot` | public | `{ email }` -> always 200 `{ resendAfterSec }` |
| POST | `/auth/password/reset` | public | `{ email, code, password }` -> 200; revokes ALL sessions |
| POST | `/auth/password/change` | member | `{ currentPassword, newPassword }` -> 200; revokes OTHER sessions |
| POST | `/auth/refresh`, `/logout`, `/logout-all` | cookie / member | unchanged |
| GET / DELETE | `/auth/sessions`, `/auth/sessions/:id` | member | unchanged |
| GET | `/members/me` | member | `{ member: { id, email, name, phone, avatarUrl, address, role, isActive, emailVerifiedAt, unpaidCommissionPaise, auctionsWon, moneySpentPaise, createdAt, deviceLimit } }` |
| PATCH | `/members/me` | member | `{ name?, phone?, address?, avatarUrl? }` -> `{ member }`; avatarUrl must start with our CloudFront/S3 base |
| GET | `/members/:id/public` | public | `{ id, name, avatarUrl, role, createdAt, ratingAvg: number\|null, ratingCount, auctionsSold, activeAuctions }`; reviews at `GET /members/:id/reviews` (`reviews.md`) |
| POST | `/uploads/presign` | member | `{ folder: auctions\|avatars, contentType: image/jpeg\|png\|webp, size <= 5 MB }` -> `{ uploadUrl, key, url }`; 503 when S3 is not configured |

`passwordHash` is never returned: all member reads go through `member.select.ts`.

## Error codes

| Status | `code` | When |
|---|---|---|
| 409 | `EMAIL_TAKEN` | signup with an already verified email |
| 401 | `INVALID_CREDENTIALS` | wrong email OR wrong password (same message, constant-time-ish) |
| 403 | `EMAIL_NOT_VERIFIED` | login before verifying; a fresh SIGNUP code is sent |
| 403 | `ACCOUNT_SUSPENDED` | `isActive = false` |
| 400 | `INVALID_CURRENT_PASSWORD` | password change with wrong current password |
| 400 | `VALIDATION_ERROR` | Joi failure (`details: [{field, message}]`) |
| 401 | `UNAUTHORIZED` | bad/expired OTP code, missing/expired session |
| 403 | `FORBIDDEN` | too many wrong OTP attempts (5) |
| 429 | `TOO_MANY_REQUESTS` | rate limit or OTP resend cooldown |
| 503 | `SERVICE_UNAVAILABLE` | email send failed / uploads not configured |

Password rule: 8-72 bytes, at least one letter and one number. Emails are trimmed + lower-cased.

## Flows

- Signup: create unverified member (or, if an unverified one exists, update name/password/role) -> SIGNUP OTP -> `verify` sets `emailVerifiedAt`, issues session cookies, sends welcome email.
- Login: password check first (unknown email costs the same as a wrong password), then verified check, then active check, then `issueSession` (device cap, default 3, evicts oldest).
- Forgot/reset: OTP (purpose PASSWORD_RESET) is only sent if the member exists, but the response is identical either way. Reset also marks the email verified, deletes every session and clears cookies.
- OTP: 6 digits, 10 min TTL, 5 attempts, 30 s resend cooldown. A resend inside the TTL re-sends the same code. Stub email driver always issues `OTP_STUB_CODE` and logs it.

## Rate limits (Postgres store)

`otpIpLimiter` + `otpLimiter` (IP, then IP+email) on signup / resend / forgot; `authLimiter` (per IP) on verify / login / reset / change; `loginEmailLimiter` (10 / 15 min per email) on login; `sensitiveLimiter` on presign.

## Email provider

`emailProvider.send({ to, subject, template, data })` renders `src/templates/<template>.ejs` (HTML) and `<template>.txt.ejs` (plain text). Templates: `otp-code` (`code`, `purpose`, `expiryMinutes`), `welcome` (`name`, `role`). Drivers: `ses`, `stub` (logs only).
