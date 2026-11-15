# Auth flow (email + password)

Email + password (bcryptjs, cost 12). Email OTP is used only to verify the email at signup and for forgot-password. Optional TOTP two-factor auth (below) and SMS-OTP phone verification (below) sit on top. Auth = httpOnly cookies `nb_at` (access) / `nb_rt` (refresh) or `Authorization: Bearer`. Success envelope `{ success: true, data }`; errors `{ success: false, error: { code, message, details? } }`.

Code: `src/modules/auth/*`, `src/modules/members/*`, `src/modules/uploads/*`, `src/providers/email/*`, `src/providers/sms/*`, `src/core/security/{totp,secret-box}.ts`, `src/templates/*`.

## Endpoints

| Method | Path | Auth | Body -> response |
|---|---|---|---|
| POST | `/auth/signup` | public | `{ name, email, password, role: BIDDER\|AUCTIONEER }` -> 201 `{ email, resendAfterSec }` |
| POST | `/auth/signup/verify` | public | `{ email, code }` -> cookies + `{ member }`; welcome email |
| POST | `/auth/signup/resend` | public | `{ email }` -> `{ resendAfterSec }` (429 inside cooldown, `details.resendAfterSec`) |
| POST | `/auth/login` | public | `{ email, password, deviceInfo? }` -> cookies + `{ member }`; when the member has 2FA enabled: 200 `{ twoFactorRequired: true, challengeToken }` and **no session, no cookies** |
| POST | `/auth/2fa/verify` | public (`authLimiter` + `twoFactorLimiter`) | `{ challengeToken, code? (6 digits), recoveryCode?, deviceInfo? }` (exactly one of `code` / `recoveryCode`) -> same cookies + `{ member }` as a normal login |
| POST | `/auth/2fa/setup` | member | -> `{ secret, otpauthUrl }`; stores the secret encrypted, not enabled yet; 409 `TWO_FACTOR_ALREADY_ENABLED` |
| POST | `/auth/2fa/enable` | member | `{ code }` -> `{ recoveryCodes: string[10] }` (shown once); 400 `TWO_FACTOR_INVALID_CODE` |
| POST | `/auth/2fa/disable` | member | `{ password, code }` (code may be a recovery code) -> `{ message }`; clears secret, `twoFactorEnabledAt`, recovery codes |
| POST | `/auth/2fa/recovery-codes` | member | `{ code }` (TOTP or recovery code) -> `{ recoveryCodes }`; replaces all codes |
| POST | `/auth/password/forgot` | public | `{ email }` -> always 200 `{ resendAfterSec }` |
| POST | `/auth/password/reset` | public | `{ email, code, password }` -> 200; revokes ALL sessions |
| POST | `/auth/password/change` | member | `{ currentPassword, newPassword }` -> 200; revokes OTHER sessions |
| POST | `/auth/refresh`, `/logout`, `/logout-all` | cookie / member | unchanged |
| GET / DELETE | `/auth/sessions`, `/auth/sessions/:id` | member | unchanged |
| GET | `/members/me` | member | `{ member: { id, email, name, phone, avatarUrl, address, role, isActive, emailVerifiedAt, phoneVerifiedAt: string\|null, whatsappOptIn: boolean, twoFactorEnabled: boolean, verified: boolean, twoFactorSetupRequired: boolean, unpaidCommissionPaise, auctionsWon, moneySpentPaise, createdAt, deviceLimit, activeStrikes } }` (`activeStrikes` = active unpaid-sale strikes, see `strikes.md`). The same member DTO is returned by login, `/auth/2fa/verify`, signup verify and `PATCH /members/me`. `twoFactorSetupRequired` = SUPER_ADMIN && `REQUIRE_ADMIN_2FA=true` && 2FA not enabled |
| POST | `/members/me/phone/otp` | active member (`otpIpLimiter` + `otpLimiter`) | `{ phone }` (10-digit Indian mobile, `^[6-9][0-9]{9}$`) -> `{ sentTo: '+91******3210' }`; 429 inside the 30 s resend cooldown; 503 if the SMS send fails |
| POST | `/members/me/phone/verify` | active member (`authLimiter`) | `{ phone, code }` -> `{ member }`; sets `Member.phone` (10-digit form) and `phoneVerifiedAt = now`, then refreshes the verified-seller badge. 401 bad / expired code, 403 after 5 wrong attempts |
| PATCH | `/members/me` | member | `{ name?, phone?, address?, avatarUrl? }` -> `{ member }`; avatarUrl must start with our CloudFront/S3 base. Changing (or clearing) `phone` clears `phoneVerifiedAt` and `whatsappOptInAt` and re-evaluates the verified badge |
| POST | `/members/me/whatsapp` | active member | `{ optIn: boolean }` -> `{ whatsappOptIn }`; opting in needs `phoneVerifiedAt` (409 `PHONE_NOT_VERIFIED`); opting out always works. Verifying a different number via `/members/me/phone/verify` also clears the opt-in. See `notification-preferences.md` |
| GET / PUT | `/members/me/following`, `/members/me/notification-preferences` | active member | see `follows.md`, `notification-preferences.md` |
| GET | `/members/:id/public` | public | `{ id, name, avatarUrl, role, createdAt, verified: boolean, ratingAvg: number\|null, ratingCount, auctionsSold, activeAuctions }`; reviews at `GET /members/:id/reviews` (`reviews.md`) |
| POST | `/uploads/presign` | member | `{ folder: auctions\|avatars, contentType: image/jpeg\|png\|webp, size <= 5 MB }` -> `{ uploadUrl, key, url }`; 503 when S3 is not configured |

`passwordHash` is never returned: all member reads go through `member.select.ts`.

`POST /auth/signup` also accepts an optional `referralCode` (invalid, own or disabled codes are ignored silently; a valid one creates a PENDING referral, see `referrals.md`). `PATCH /members/me` accepts `gstin` and `billingState` (GSTIN format, prefix must equal the state, else 400 `INVALID_GSTIN`; see `invoices.md`).

## Error codes

| Status | `code` | When |
|---|---|---|
| 409 | `EMAIL_TAKEN` | signup with an already verified email |
| 401 | `INVALID_CREDENTIALS` | wrong email OR wrong password (same message, constant-time-ish) |
| 403 | `EMAIL_NOT_VERIFIED` | login before verifying; a fresh SIGNUP code is sent |
| 403 | `ACCOUNT_SUSPENDED` | `isActive = false` |
| 400 | `INVALID_CURRENT_PASSWORD` | password change, or 2FA disable, with wrong current password |
| 400 | `TWO_FACTOR_INVALID_CODE` | wrong / used TOTP or recovery code (enable, disable, regenerate, verify) |
| 400 | `TWO_FACTOR_NOT_ENABLED` | disable / regenerate recovery codes without 2FA |
| 409 | `TWO_FACTOR_ALREADY_ENABLED` | setup / enable while 2FA is on |
| 401 | `TWO_FACTOR_CHALLENGE_INVALID` | `/auth/2fa/verify` with a bad / expired (5 min) challenge token |
| 403 | `TWO_FACTOR_SETUP_REQUIRED` | `/admin/*` as a SUPER_ADMIN without 2FA while `REQUIRE_ADMIN_2FA=true` |
| 503 | `TWO_FACTOR_UNAVAILABLE` | `TOTP_ENC_KEY` missing / malformed: setup, enable (and decrypting for verify) |
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

## Phone verification (SMS OTP)

`POST /members/me/phone/otp` -> `issueOtpChallenge('+91' + phone, 'PHONE_VERIFY')` (`OtpChannel.SMS`; same cooldown / 5 attempts / bcrypt hashing / 10 min TTL as the email OTP) -> `smsProvider.send({ to, text, templateVars: { otp } })`. `verify` -> `consumeOtpChallenge`, then `Member.phone = <10 digits>`, `phoneVerifiedAt = now`, `refreshSellerVerification`. The SMS code is random outside the stub driver; with `SMS_DRIVER=stub` and not production it is `OTP_STUB_CODE` (logged as `devOtp`, number masked).

## SMS provider

`src/providers/sms/` mirrors the email provider: `smsProvider.send({ to (E.164), text, templateVars? })`. Drivers by `SMS_DRIVER`: `stub` (default; logs the masked number `+91******3210`, plus the code outside production) and `msg91` (MSG91 Flow API `POST https://control.msg91.com/api/v5/flow` over `fetch`, header `authkey`, body `{ template_id, short_url: '0', recipients: [{ mobiles, otp }] }`). Env: `MSG91_AUTH_KEY` (secret), `MSG91_SENDER_ID`, `MSG91_OTP_TEMPLATE_ID`. **India needs a DLT-registered sender id and OTP template** (the template carries an `##otp##` variable) before MSG91 delivers anything; the boot check refuses `SMS_DRIVER=msg91` in production without the auth key and template id.

## Two-factor auth (TOTP)

RFC 6238 (HMAC-SHA1, 30 s, 6 digits, accepts +-1 step) implemented in `src/core/security/totp.ts` (node `crypto`, no dependency, RFC test vectors in `security.test.ts`). The secret is stored AES-256-GCM encrypted (`src/core/security/secret-box.ts`, key `TOTP_ENC_KEY` = 32 bytes base64, format `base64(iv|tag|ciphertext)`) in `Member.totpSecretEnc`; `Member.twoFactorEnabledAt` marks it active. With no / malformed key, setup and enable answer 503 `TWO_FACTOR_UNAVAILABLE`; login for members without 2FA is unaffected.

- Enable: `setup` (secret + `otpauth://totp/NobleBid:<email>?secret=..&issuer=NobleBid`) -> user scans -> `enable { code }` creates 10 `RecoveryCode` rows (`codeHash` = sha256 of the normalized `XXXX-XXXX` code; plaintext returned once).
- Login: password OK + `twoFactorEnabledAt` -> 200 `{ twoFactorRequired: true, challengeToken }`. The token is a JWT signed with `JWT_SECRET`, `typ: '2fa'`, `sub: memberId`, 5 min, carrying the login's `deviceInfo`; `authenticate` rejects any token with a `typ` claim, so it is not a session token. `POST /auth/2fa/verify` checks it, the code (or an unused recovery code, stamped `usedAt` with a guarded update) and the active flag, then runs the exact normal-login session path (`issueSession`, cookies) and returns `{ member }`.
- `twoFactorLimiter` (`rl:2fa:`): 5 attempts / 10 min per member id taken from the verified challenge token (IP fallback for a bad token), after `authLimiter`.
- Admin enforcement: `REQUIRE_ADMIN_2FA=true` makes `requireRole('SUPER_ADMIN')` answer 403 `TWO_FACTOR_SETUP_REQUIRED` (live DB read of `twoFactorEnabledAt`) for admins without 2FA; `/auth/2fa/*` and `/members/me` stay reachable. Default `false`.
- Logging: `secret`, `totpSecret`, `totpSecretEnc`, `recoveryCode(s)` and `challengeToken` are redacted (also nested 1-2 levels); codes, secrets and tokens are never logged.

## Verified seller

`refreshSellerVerification(memberId)` (`members/verification.service.ts`): verified iff role AUCTIONEER, `phoneVerifiedAt` set, payout account `ACTIVE`, `verificationRevokedAt` null; it sets `verifiedAt` (original timestamp kept while still verified) or clears it. Called after phone verify, a profile phone change, payout account create and Route product webhooks, and admin role / verified changes. Admin revoke: `PATCH /admin/members/:id { verified: false }` (see `admin.md`). Exposed as `verified: boolean` on seller objects (`auctions.md`) and public profiles.

## Rate limits (Postgres store)

`otpIpLimiter` + `otpLimiter` (IP, then IP+email) on signup / resend / forgot; `authLimiter` (per IP) on verify / login / reset / change; `loginEmailLimiter` (10 / 15 min per email) on login; `sensitiveLimiter` on presign; `twoFactorLimiter` on `/auth/2fa/verify`; phone OTP send uses `otpIpLimiter` + `otpLimiter`, phone verify `authLimiter`.

## Email provider

`emailProvider.send({ to, subject, template, data })` renders `src/templates/<template>.ejs` (HTML) and `<template>.txt.ejs` (plain text). Templates: `otp-code` (`code`, `purpose`, `expiryMinutes`), `welcome` (`name`, `role`). Drivers: `ses`, `stub` (logs only).
