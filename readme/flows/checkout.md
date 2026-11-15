# Checkout flow (winner pays in-app, Razorpay Route)

Code: `src/modules/sales/` (`sales.{routes,controller,service,validation,rules,jobs}.ts`), `src/modules/admin/sales/`, settlement in `src/modules/payments/payments.service.ts`, close in `src/modules/auctions/auction-close.service.ts`, provider in `src/providers/payment/`. Seller onboarding: `payouts.md`. Decision: D10 in `docs/DECISIONS.md` (supersedes D2 when the mode is not `off`).

## Business rule

When an auction sells and the seller has an ACTIVE payout account, the winner pays the platform in the app. The money is held (a Route transfer created `on_hold`), then released to the seller's linked account minus the platform commission after delivery is confirmed (or 7 days after shipping). Legacy flow (seller pays a DUE commission) stays for sellers without an ACTIVE payout account and when the mode is `off`.

AppSetting `checkout.mode` (admin `PUT /admin/settings` `checkoutMode`, public `GET /settings/public` `checkoutMode`, default `optional`, seeded):

| Mode | Close | `createAuction` |
|---|---|---|
| `off` | legacy only (Commission DUE, `unpaidCommissionPaise`) | unchanged |
| `optional` | Sale when the seller has an ACTIVE payout account, else legacy | unchanged |
| `required` | same as optional | 403 `PAYOUT_ACCOUNT_REQUIRED` ("Set up payouts before listing") unless the payout account is ACTIVE; `COMMISSION_UNPAID` is still checked first |

## Sale state machine

```
AWAITING_PAYMENT --pay (verify / webhook)--> PAID --ship (seller)--> SHIPPED
   | payBy passed (job)                        |                       |
   v                                           +---- confirm (buyer) --+--> DELIVERED --release--> RELEASED
CANCELLED                                      |           (or auto-confirm 7 days after shippedAt)
                                               +---- dispute (buyer, PAID|SHIPPED|DELIVERED) --> DISPUTED
DISPUTED --admin release--> RELEASED     PAID|SHIPPED|DELIVERED|DISPUTED --admin refund--> REFUNDED
```

Every transition is a guarded `updateMany` (`WHERE status IN (...)`), so concurrent or repeated calls are no-ops. Wrong state -> 409 `SALE_INVALID_STATE`; not a party -> 404 `SALE_NOT_FOUND`.

`Sale` columns: `itemPaise`, `shippingFeePaise` (0 for now), `amountPaise` (item + shipping), `commissionPaise` (`commissionAmountPaise(item, rateBps)`), `rateBps`, `payBy` (close + 3 days), status timestamps, `gatewayPaymentId`, `transferId`, shipping fields, dispute / resolution fields. All money columns are BigInt paise (`toPaise` at the boundary). An auction can have several Sales over time (a cancelled one, then a second-chance one: `strikes.md`); at most one is open, enforced by the partial unique index `Sale_open_per_auction` (migration SQL only) with `@@index([auctionId])` in Prisma. Lookups by auction use the latest sale.

## Close

`closeOneTx(tx, auctionId, now, rateBps, checkoutMode)` (also used by Buy It Now): when sold and the rule above applies it creates the Sale, does NOT create a DUE Commission and does NOT increment `unpaidCommissionPaise`; the winner's `auctionsWon` / `moneySpentPaise` are still incremented. `afterClose` sends `auction-won` (`data.saleId`, `payBy`; copy "Pay within 3 days", url `/purchases/<saleId>`, no seller contact before payment) and `auction-sold` (`data.checkout: true`, `saleId`); no `commission-due`.

## Endpoints

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/sales/mine?role=buyer\|seller&status=&page&limit` | any active member | paginated `SaleDTO[]` (default `role=buyer`; `limit` default 20 max 100, `pageSize` accepted as an alias) |
| GET | `/sales/:id` | buyer, seller, SUPER_ADMIN | `SaleDTO` |
| POST | `/sales/:id/checkout` | buyer (BIDDER) | optional body `{ delivery?: 'COURIER'\|'PICKUP' }` (see Delivery choice). Same payload as commissions: `{ orderId, amountPaise, currency: 'INR', keyId, description, prefill }`. 400 `DELIVERY_CHOICE_REQUIRED`, 409 `SALE_NOT_PAYABLE` (not AWAITING_PAYMENT or past `payBy`), 409 `PAYOUT_ACCOUNT_INACTIVE` |
| POST | `/sales/:id/ship` | seller (AUCTIONEER) | `{ method: 'COURIER'\|'PICKUP', courier? <= 60 (required for COURIER), trackingNo? <= 60 }`; PAID -> SHIPPED; notifies the buyer |
| POST | `/sales/:id/confirm` | buyer | PAID\|SHIPPED -> DELIVERED, then release -> RELEASED. If the release call fails the sale stays DELIVERED (the job retries); the response is still 200 with the current state |
| POST | `/sales/:id/dispute` | buyer | `{ reason: 10..1000 }`; PAID\|SHIPPED\|DELIVERED -> DISPUTED; notifies the seller and every active SUPER_ADMIN |
| POST | `/sales/:id/second-chance` | seller (AUCTIONEER) | offer a CANCELLED sale to the runner-up -> `{ offer }`; see `strikes.md` |
| POST | `/payments/verify` | order owner | now `{ referenceType: 'COMMISSION', commission }`, `{ referenceType: 'SALE', sale }`, `{ referenceType: 'DEPOSIT', deposit }` (`deposits.md`) or `{ referenceType: 'FEATURE', purchase }` (`featured.md`) |
| GET | `/admin/sales?status=&q=&page&limit` | SUPER_ADMIN | paginated `SaleDTO` (role ADMIN) with buyer / seller emails; `q` matches id, auction title, buyer / seller name or email |
| POST | `/admin/sales/:id/release` | SUPER_ADMIN | DISPUTED\|DELIVERED -> RELEASED (`resolution = RELEASED_BY_ADMIN`, `resolvedAt` when it was disputed); 502 `RELEASE_FAILED` when the gateway call fails |
| POST | `/admin/sales/:id/refund` | SUPER_ADMIN | `{ note? <= 500 }`; PAID\|SHIPPED\|DELIVERED\|DISPUTED -> REFUNDED; 409 `SALE_NO_PAYMENT` without a payment id; marks the PAID Commission row WAIVED; notifies both |

`SaleDTO` = `{ id, auctionId, auction { id, title, coverImage }, status, itemPaise, shippingFeePaise, deliveryChoice: 'COURIER'|'PICKUP'|null, shippingOptions (the auction's, same shape as the auction detail; null for legacy auctions), amountPaise, payBy, paidAt, shippingMethod, courier, trackingNo, shippedAt, deliveredAt, releasedAt, disputedAt, disputeReason, refundedAt, cancelledAt, createdAt, role 'BUYER'|'SELLER'|'ADMIN', buyer { id, name }, seller { id, name } }` plus `commissionPaise` and `payoutPaise` (seller and admin only), `buyerContact { name, email, phone }` (seller only, once paid), `sellerContact` (buyer only, once paid). The seller view also has `secondChanceOffer: OfferDTO | null` and `canOfferSecondChance: boolean` (`strikes.md`).

Auction detail (`GET /auctions/:id`) has `sale: { id, status, payBy } | null` for the buyer, the seller and admins; `GET /bids/mine` rows have `saleId` and `saleStatus`. The admin dashboard has `salesByStatus: { <status>: { count, amountPaise } }` (all statuses, zero-filled).

## Delivery choice

`Auction.shippingOptions` (`auctions.md`) says what the seller offers; `Sale.deliveryChoice` (`'COURIER'|'PICKUP'`, nullable) records the buyer's pick. `POST /sales/:id/checkout` decides with `resolveDelivery` (`sales.rules.ts`) after the state / payout checks and before any gateway call:

- the auction has **no** `shippingOptions` (legacy): behave as before, the sale is not touched (fee 0);
- both pickup and courier offered: `delivery` is required, else 400 `DELIVERY_CHOICE_REQUIRED`;
- only one offered: that one is used (a conflicting `delivery` is ignored).

Courier sets `shippingFeePaise` to the auction fee (0 when absent), pickup to 0. The sale is updated (`deliveryChoice`, `shippingFeePaise`, `amountPaise = itemPaise + fee`) with a guarded `updateMany` that only matches `AWAITING_PAYMENT` (count 0 -> 409 `SALE_NOT_PAYABLE`), only when something changed. Commission stays on the item price (`commissionPaise` is unchanged), so the Route transfer to the seller is `amount - commission` and the shipping fee goes to the seller. The order, its amount and the transfer use the updated amount, and the 30 minute order reuse only matches a CREATED order with exactly that amount, so switching delivery never reuses a stale order.

## Razorpay calls

1. Order (`POST /v1/orders`): `amount` = sale amount, `partial_payment: false`, `transfers: [{ account, amount: amount - commission, currency: 'INR', notes, on_hold: true }]`. A CREATED `PaymentOrder` (`referenceType 'SALE'`, `referenceId` = sale id, `idempotencyKey sale:<id>:<gatewayOrderId>`) younger than 30 min for the same (post-delivery-choice) amount is reused. Receipt `s_<12 id chars>_<base36 time>`.
2. Settlement (`markSalePaid`, one transaction, shared by `/payments/verify` and the webhook): guarded update AWAITING_PAYMENT -> PAID (+ `paidAt`, `gatewayPaymentId`), `PaymentOrder` -> PAID, and a Commission row with status PAID (`paidAt`, `paymentOrderId`, amount = `commissionPaise`) so admin commission reports stay right. After commit, best-effort `GET /v1/payments/:id/transfers` stores `transferId` (also retried on release and by `transfer.processed`); the seller gets `sale-paid`, the buyer `sale-receipt`. A second call changes nothing. A payment that arrives after the sale was CANCELLED is recorded on the order only (refund manually).
3. Release: `PATCH /v1/transfers/:id { on_hold: false }` (transfer fetched first when `transferId` is null), then RELEASED + `releasedAt` and `sale-released` to the seller.
4. Refund: `POST /v1/payments/:id/refund { amount, reverse_all: 1 }`.
5. Webhooks (`POST /payments/webhook`, dispatch on `PaymentOrder.referenceType`): `payment.captured` / `order.paid` -> `markCommissionPaid` (COMMISSION) or `markSalePaid` (SALE); `payment.failed`; `transfer.processed` stores a missing `transferId` (matched on the payment id); `product.route.*` events update `SellerPayoutAccount.status` by Razorpay account id. Add `transfer.processed` and the `product.route.*` events to the dashboard webhook subscription.

## Maintenance job (`salesMaintenanceHandler`)

Lambda `salesMaintenance`, `rate(1 hour)` (`index.salesMaintenanceHandler`; locally every 10 min; `npm run job:sales` runs one pass by hand). Each pass is batch-limited (100 per step), idempotent, and logs and skips a failing sale: (1) AWAITING_PAYMENT past `payBy` -> CANCELLED + a `Strike` for the buyer in the same transaction + `sale-cancelled` to both, then the strike policy (`strikes.md`); (2) SHIPPED with `shippedAt` older than 7 days -> DELIVERED -> release; (3) DELIVERED with `releasedAt` null -> release retry; (4) held bid deposits are refunded or forfeited (`deposits.md`); (5) PENDING second-chance offers past `expiresAt` -> EXPIRED. Returns `{ cancelled, autoConfirmed, releaseRetried, depositsRefunded, depositsForfeited, offersExpired }`.

## Notifications

Hooks (best-effort, never fail the sale): `markSalePaid` issues a COMMISSION GST invoice for the PAID commission row it writes (`invoices.md`); a sale reaching RELEASED qualifies the buyer's and the seller's referral (`referrals.md`). `sale-receipt` (buyer), `sale-paid` (seller), `sale-shipped` (buyer), `sale-released` (seller), `sale-disputed` (seller + each SUPER_ADMIN), `sale-refunded` (both), `sale-cancelled` (both). Trust-2 types (`strike-issued`, `account-suspended`, `deposit-*`, `second-chance-*`) are in `strikes.md` / `deposits.md`. Dedupe `<type>:<saleId>` and `:<memberId>` for the multi-recipient ones. Links: buyer `/purchases/<id>`, seller `/sell/sales/<id>`, admin `/admin/sales`. Details in `notifications.md`.

## Reviews

A sale-backed auction is reviewable only when the sale is DELIVERED or RELEASED; the 60-day window counts from `deliveredAt` (the release time if released without a delivery). Legacy auctions without a Sale keep the old rule. See `reviews.md`.

## VERIFY in Razorpay test mode

- `on_hold` as boolean (`true`) vs `1` in the order `transfers` array.
- `GET /v1/payments/:id/transfers` response shape (`items` vs `transfers`) and the `recipient` field name.
- `PATCH /v1/transfers/:id { on_hold: false }` releasing the hold (or whether `on_hold_until` is needed).
- Whether `transfer.processed` fires on creation or on release, and that `transfer.source` is the payment id.
- `product.route.*` event names, the payload key (`product.route`) and the location of `account_id`; `requirements[]` field names used for `statusReason`.
- `profile.category` / `subcategory` values accepted for individual sellers (`ecommerce` / `ecommerce_marketplace` used), and that `street2` may repeat `street1`.
- `reverse_all: 1` reverses the on-hold transfer when the funds were never released.

## Tests

`sales/sales.test.ts` (DTO visibility, checkout reuse / creation / on-hold amount, `markSalePaid` idempotency + PAID Commission, ship / confirm / dispute state machine and party checks, release failure keeps DELIVERED, admin release / refund, maintenance job), `auction-close.service.test.ts` (Sale only per mode + payout status), `payments.service.test.ts` (dispatch by `referenceType`, transfer and product webhooks), `payment.provider.test.ts`, `reviews.test.ts`, `auctions.test.ts` (required mode), plus the guards / validation HTTP matrices.
