# Payout accounts flow (Razorpay Route linked accounts)

Code: `src/modules/payouts/` (`payouts.{routes,controller,service,validation}.ts`), provider `createRouteAccount` in `src/providers/payment/`. Used by the checkout flow (`checkout.md`): a sale is only created for sellers whose account is ACTIVE.

## Schema

`SellerPayoutAccount { id, sellerId @unique -> Member, razorpayAccountId @unique, productId?, status PayoutStatus (PENDING | NEEDS_CLARIFICATION | ACTIVE | SUSPENDED | REJECTED, default PENDING), statusReason?, legalName, businessType, bankLast4, ifsc, beneficiaryName, createdAt, updatedAt }`. **PAN and the full bank account number are never stored** (they go to Razorpay only); only the last 4 digits are kept.

## Endpoints (AUCTIONEER, active member)

| Method | Path | Notes |
|---|---|---|
| GET | `/payouts/account` | `{ account: PayoutAccountDTO \| null }`; DTO `{ status, statusReason, legalName, businessType, bankLast4, ifsc, beneficiaryName, createdAt, updatedAt }` |
| POST | `/payouts/account` | 201 `{ account }`. Rate limited by `sensitiveLimiter`. Body `{ legalName <= 120, businessType 'individual'\|'proprietorship', phone /^[6-9][0-9]{9}$/, pan /^[A-Z]{5}[0-9]{4}[A-Z]$/, accountNumber 9..18 digits, ifsc /^[A-Z]{4}0[A-Z0-9]{6}$/, beneficiaryName <= 120, address { street1 <= 100, city <= 60, state <= 60, postalCode 6 digits } }` (PAN and IFSC are upper-cased by validation). 409 `PAYOUT_ACCOUNT_EXISTS` unless the existing account is REJECTED (then it is replaced, with a fresh Razorpay `reference_id`). |

`createAccount` calls `paymentProvider.createRouteAccount` with the member's email (login email), name (`contactName`) and id (`referenceId`). The driver makes the four v2 calls: `POST /v2/accounts` (type `route`), `POST /v2/accounts/:id/stakeholders`, `POST /v2/accounts/:id/products` (`product_name: 'route'`), `PATCH /v2/accounts/:id/products/:productId` (settlements + `tnc_accepted`). The product `activation_status` maps to `PayoutStatus` (`activated` -> ACTIVE, `needs_clarification`, `suspended`, `rejected`, anything else -> PENDING).

## Status updates

Webhooks `product.route.activated` / `needs_clarification` / `under_review` (and other `product.route.*`) update the row by `razorpayAccountId`; `statusReason` carries the requirement reason codes for NEEDS_CLARIFICATION (cleared otherwise). Exact event names and payload shape are marked VERIFY in `checkout.md`.

## Verified-seller badge

A seller's badge depends on the payout account status being `ACTIVE` (plus a verified phone). `refreshSellerVerification(sellerId)` runs after `createAccount` and after every `product.route.*` webhook that updates a row, so activation grants the badge and SUSPENDED / REJECTED / NEEDS_CLARIFICATION removes it (`auth.md`, `payments.md`).

## Stub mode

`PAYMENT_DRIVER=stub`: `createRouteAccount` returns `acc_stub_<hash of referenceId>` with status ACTIVE immediately, so the whole checkout flow works in dev without Razorpay.

## Logging

The pino logger redacts `pan` and `accountNumber` (also nested one and two levels deep). The payouts code never logs the request body.

## Tests

`payouts/payouts.test.ts` (PAN / IFSC / account / phone validation, stored fields, one-per-seller, REJECTED replacement) and the guards / validation HTTP matrices.
