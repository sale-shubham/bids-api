# Payments flow (seller commissions via Razorpay)

> Winner checkout (`PaymentOrder.referenceType = 'SALE'`, Razorpay Route held transfers) is documented in `checkout.md`, refundable bid deposits (`'DEPOSIT'`) in `deposits.md`; this file covers the commission path and the shared verify / webhook plumbing.

Code: `src/modules/commissions/` (list, summary, checkout, settlement, reminders), `src/modules/payments/` (verify + webhook), `src/providers/payment/` (Razorpay + stub drivers).

> Also settled here: `PaymentOrder.referenceType = 'FEATURE'` (paid featured listings, `featured.md`): verify and the webhook call `markFeaturePaid`; verify answers `{ referenceType: 'FEATURE', purchase }`. Credits (`referrals.md`) can pay a whole commission: `POST /commissions/:id/checkout` with `{ useCredits: true }` answers `{ paidWithCredits: true, commission }` (`409 INSUFFICIENT_CREDITS` if the balance does not cover it; no partial use, D15). A commission becoming PAID (any path) also issues a GST invoice and may qualify the seller's referral, both best-effort (`invoices.md`).

## Business rule

When an auction sells, the close job creates a `Commission` (rate from `commission.rateBps` setting, default 5%; status `DUE`; `dueAt` = +7 days) and adds it to `Member.unpaidCommissionPaise`. While that is > 0 the seller cannot create auctions (`403 COMMISSION_UNPAID`). The seller pays through Razorpay Orders (one-time orders, no subscriptions). Money is integer paise.

## Flow

```
Seller (web)                    API                               Razorpay
    |  POST /commissions/:id/checkout                                |
    |------------------------->| owner + DUE? reuse CREATED order    |
    |                          | (<30 min, same amount) else ------->| POST /v1/orders
    |                          |<-------------------------------------| order_id
    |<-- { orderId, keyId, amountPaise, prefill, ... }               |
    |  open Razorpay Checkout (orderId, keyId) ---------------------->|
    |<-- handler({ razorpay_order_id, razorpay_payment_id, razorpay_signature })
    |  POST /payments/verify { orderId, paymentId, signature }       |
    |------------------------->| order is mine -> HMAC check         |
    |                          | fetchPayment ---------------------->| GET /v1/payments/:id
    |                          | captured|authorized + amount match  |
    |                          | markCommissionPaid (1 tx)           |
    |<-- { commission }        |                                     |
    |                          |<-- POST /payments/webhook (payment.captured / order.paid)
    |                          |    HMAC on raw body, dedupe, markCommissionPaid (no-op if already PAID)
```

The browser callback and the webhook race on purpose: whichever arrives first settles, the other is a no-op. The webhook is the safety net when the user closes the tab after paying.

## Endpoints

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/commissions/mine?status=due\|paid\|waived\|all&page&pageSize` | AUCTIONEER / SUPER_ADMIN | paginated `CommissionDTO[]` (default `due`, ordered by `dueAt` asc; other filters newest first) |
| GET | `/commissions/summary` | AUCTIONEER / SUPER_ADMIN | `{ unpaidPaise, dueCount, overdueCount }` |
| GET | `/commissions/:id` | owner (AUCTIONEER / SUPER_ADMIN) | `CommissionDTO`; 404 `COMMISSION_NOT_FOUND` if missing or not the caller's (the app polls this while Razorpay Checkout is open) |
| POST | `/commissions/:id/checkout` | owner | `{ orderId, amountPaise, currency: 'INR', keyId, description, prefill: { name, email, contact } }` |
| POST | `/payments/verify` | any authenticated member who owns the order | `{ referenceType: 'COMMISSION', commission: CommissionDTO }` for a sale order `{ referenceType: 'SALE', sale: SaleDTO }`, or for a bid deposit `{ referenceType: 'DEPOSIT', deposit: DepositDTO }` |
| POST | `/payments/webhook` | none (Razorpay, `X-Razorpay-Signature`) | `{ processed: true }` or `{ skipped: true }` |

`CommissionDTO` (seller-facing, never carries the admin's waive note; the admin list and waive response add `waivedNote: string|null`) = `{ id, auctionId, auction: { id, title, coverImage, finalBidPaise, endedAt }, rateBps, amountPaise, status: 'DUE'|'PAID'|'WAIVED', dueAt, paidAt, createdAt, isOverdue }` (`isOverdue` = DUE and past `dueAt`).

## Errors

| Status | Code | When |
|---|---|---|
| 404 | `COMMISSION_NOT_FOUND` | checkout: not the owner / no such commission |
| 409 | `COMMISSION_NOT_DUE` | checkout (or waive): commission already PAID / WAIVED |
| 404 | `ORDER_NOT_FOUND` | verify: order unknown or belongs to another member |
| 400 | `INVALID_SIGNATURE` | verify: HMAC (order_id\|payment_id) mismatch |
| 409 | `PAYMENT_NOT_CAPTURED` | verify: gateway payment is not `captured` / `authorized` |
| 409 | `AMOUNT_MISMATCH` | verify: gateway amount differs from the order amount |
| 409 | `ORDER_REFERENCE_UNKNOWN` | verify: the order pays for neither a commission, a sale nor a deposit |
| 400 | `BAD_REQUEST` | webhook: bad signature or unparsable body |

## Checkout details

- A `PaymentOrder` (`referenceType = 'COMMISSION'`, `referenceId = commissionId`, `status CREATED`) is stored per Razorpay order. A CREATED order for the same commission and amount younger than 30 min is returned again (no order spam).
- Razorpay order: amount in paise, `INR`, `receipt` = `c_<last 12 of commission id>_<base36 time>` (<= 40 chars), `notes = { commissionId, memberId }`.

## Settlement dispatch

`verifyPayment` and the webhook `processEvent` read `PaymentOrder.referenceType`: `COMMISSION` -> `markCommissionPaid` (unchanged), `SALE` -> `markSalePaid` (`checkout.md`; for the webhook also `storeTransferId`), `DEPOSIT` -> `markDepositHeld` (`deposits.md`: guarded PENDING -> HELD; the webhook also finds the order by the `depositId` note; verify returns `{ referenceType: 'DEPOSIT', deposit }`). Extra webhook events: `transfer.processed` (stores a missing `Sale.transferId`) and `product.route.*` (updates `SellerPayoutAccount.status`, `payouts.md`). With `checkout.mode` `off`, or sellers without an ACTIVE payout account, nothing changes: sold auctions still create DUE commissions.

## Idempotency

- `markCommissionPaid({ paymentOrderId, gatewayPaymentId })` runs in ONE transaction: a guarded `UPDATE Commission ... WHERE id AND status = 'DUE'` -> PAID (+ `paidAt`, `paymentOrderId`); `PaymentOrder` -> PAID + `gatewayPaymentId`; `Member.unpaidCommissionPaise = GREATEST(0, unpaid - amount)` (never negative). Only when the guarded update hit a row does the decrement run and the `commission-paid` notification (`dedupeKey commission-paid:<commissionId>`) get queued after commit. A second call (verify + webhook, redelivery) changes nothing.
- Webhook: `WebhookEvent.gatewayEventId` (the `X-Razorpay-Event-Id` header, else `<type>:<entity id>`) is checked first; the row is written after processing so a failure is retried by Razorpay. Valid signatures always get 200, even for unknown events or unknown orders.
- Webhook events: `payment.captured` / `order.paid` settle the order (found by Razorpay order id, falling back to `notes.commissionId`); `payment.failed` marks a CREATED order FAILED (a later successful retry on the same order still settles).
- A double payment (two orders for one commission) settles the commission once; the second order is still marked PAID and logged so it can be refunded manually.

## Waive and reminders

- `waiveCommission(commissionId, adminId, note?, now?)` stores `Commission.waivedNote` (nullable text, migration `20261116030000_commission_waive_note`) (admin route `POST /admin/commissions/:id/waive`, see `admin.md`): DUE -> WAIVED, unpaid decremented with the same clamp; 409 `COMMISSION_NOT_DUE` otherwise.
- `runCommissionReminders(now)`: DUE commissions past `dueAt` or older than 3 days -> `commission-due` notification with `dedupeKey commission-reminder:<id>:<YYYY-MM-DD>` (UTC date), so at most one per commission per day. Lambda: `commissionReminder` (`rate(1 day)`, `index.commissionReminderHandler`). Local dev server: once at startup, then every 6 h.

## Stub mode (`PAYMENT_DRIVER=stub`, the default)

No real gateway: checkout returns `orderId = stub_order_<uuid>` and `keyId = 'stub'`; `fetchPayment` returns `captured` with a null amount (amount check skipped); `/payments/verify` accepts ONLY `signature === 'stub'` (the frontend sends it instead of opening Checkout). With `PAYMENT_DRIVER=razorpay` the stub driver is not loaded, so `'stub'` fails the HMAC check. The stub webhook verifier accepts anything (dev only).

## Razorpay dashboard setup

1. Settings -> API Keys: generate keys; set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `PAYMENT_DRIVER=razorpay`.
2. Settings -> Webhooks -> Add (Route product events also call `refreshSellerVerification` for the seller, which grants / removes the verified-seller badge): URL `https://<api-domain>/payments/webhook`, a secret (-> `RAZORPAY_WEBHOOK_SECRET`), events `payment.captured`, `payment.failed`, `order.paid`, plus `transfer.processed` and the Route product events (`product.route.activated`, `product.route.needs_clarification`, `product.route.under_review`) for checkout.
3. Use Test mode keys/webhook on dev; live keys only in prod. Payment capture should be automatic (otherwise payments stay `authorized`, which verify accepts but the webhook events will not fire until captured).

## Tests

`src/modules/commissions/commissions.service.test.ts` (checkout reuse/new/errors, settlement idempotency + clamp, waive, reminders) and `src/modules/payments/payments.service.test.ts` (verify rules, stub signature, webhook paths). The provider is always mocked; the real Razorpay API is never called. Provider Route methods: `payment.provider.test.ts`.
