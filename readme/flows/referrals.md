# Referral credits

Code: `src/modules/referrals/` (`referrals.rules`, `referrals.service`), `src/modules/credits/credits.service.ts` (ledger), routes in `members.routes.ts` and `admin-members.routes.ts`.

## Referral

- `Member.referralCode` (unique, 8-char uppercase base32), generated lazily on the first `GET /members/me/referral` (retry on collision).
- Signup accepts an optional `referralCode`. A valid code that is not the member's own, with `referral.enabled`, creates a `PENDING` `Referral` (one per referee, unique). Invalid, own, malformed or disabled codes are ignored silently and never block signup.
- Qualification: the referee's first paid transaction, a Sale reaching `RELEASED` (buyer or seller, `releaseSale`) or a legacy Commission becoming `PAID` (seller, `afterCommissionPaid`). Both hooks are best-effort (`qualifyReferralBestEffort`). `PENDING -> QUALIFIED` is a guarded update, so it runs once. Then: a shared `Session.deviceId` with the referrer -> `REJECTED` (`SAME_DEVICE`); referrer already has `referral.maxRewardsPerMember` rewarded -> `REJECTED` (`CAP_REACHED`); otherwise the referrer gets `referral.rewardPaise` (ledger `REFERRAL_REWARD`, `refType 'REFERRAL'`), the referral is `REWARDED` and `referral-rewarded` is sent. With the program disabled the referral stays `QUALIFIED` without a reward.
- Settings: `referral.enabled` (true), `referral.rewardPaise` (10000), `referral.maxRewardsPerMember` (20); exposed as `referralEnabled`, `referralRewardPaise`, `referralMaxRewardsPerMember` in the platform settings (optional on `PUT /admin/settings`).

## Credits ledger

`MemberCredit` rows (BigInt paise, positive grants, negative debits), balance = sum. Debits (`debitCredits`) run inside the caller's transaction: they take `SELECT ... FOR UPDATE` on the Member row, re-read the balance and throw `409 INSUFFICIENT_CREDITS` rather than go below 0. Reasons: `REFERRAL_REWARD`, `FEATURE_PURCHASE`, `COMMISSION_PAYMENT`, `ADMIN_ADJUSTMENT`. Credits only cover a whole amount (D15).

## Endpoints

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/members/me/referral` | member | `{ code, link (APP_URL/signup?ref=<code>), rewardPaise, enabled, counts { pending, qualified, rewarded, rejected }, creditBalancePaise }` |
| GET | `/members/me/credits?page&pageSize` | member | paginated `{ id, amountPaise, reason, note, createdAt }`, top-level `balancePaise` next to `meta` |
| POST | `/commissions/:id/checkout` | seller | `{ useCredits: true }` pays the whole commission from credits: `{ paidWithCredits: true, commission }` (`409 INSUFFICIENT_CREDITS`, `409 COMMISSION_NOT_DUE`); without it the Razorpay payload as before |
| POST | `/admin/members/:id/credits` | SUPER_ADMIN | `{ amountPaise (non-zero int, abs <= 10,000,000), note 3..200 }` -> 201 `{ creditBalancePaise }`; a debit below 0 is `409 INSUFFICIENT_CREDITS` |

The admin member DTO (`GET /admin/members`, `PATCH /admin/members/:id`) gains `creditBalancePaise`. A commission paid with credits does the debit, the guarded `DUE -> PAID` and the unpaid-total decrement in one transaction; notice, invoice and referral hooks run after it.

## Tests

`src/modules/referrals/referrals.test.ts` (codes, attach, qualification, device / cap rejection, ledger, credits commission, admin adjustment) and the release hook in `sales/sales.test.ts`.
