# Bid deposits flow

Code: `src/modules/deposits/` (`deposits.{rules,service,jobs,routes}.ts`), pure bid gate in `src/modules/auctions/bidding.rules.ts`, deposit facts loaded in `src/modules/bids/bids.service.ts`, settlement dispatch in `src/modules/payments/payments.service.ts`, hourly release inside `src/modules/sales/sales.jobs.ts`. Decision: D12 in `docs/DECISIONS.md`.

## Business rule

A member may have to pay a **refundable deposit** (Razorpay order, no Route transfers) before bidding or using Buy It Now:

- **High-value auction:** `Auction.depositPaise` (BigInt?, null = none) = `round(startingBid * depositRateBps / 10000)` when `auction.depositThresholdPaise > 0` and the starting bid is at or above it. Computed on create and when `PATCH /auctions/:id` changes `startingBidPaise` (republish keeps the stored value: the starting bid cannot change there).
- **Strikes:** a member with 2 or more active strikes (`strikes.md`) needs, on every auction, `max(round(max(startingBid, currentBid) * depositRateBps / 10000), 50_000)` (Rs 500 floor). The auction deposit wins when it is set (they do not stack).
- Required deposit = `requiredDepositPaise` (`deposits.rules.ts`, pure). 0 means nothing is needed.

AppSettings (admin `PUT /admin/settings`, both optional on write; public `GET /settings/public` returns both; seeded):

| Key | Field | Default | Range |
|---|---|---|---|
| `auction.depositThresholdPaise` | `depositThresholdPaise` | 10_000_000 (Rs 1 lakh) | 0..`HARD_MAX_PRICE_PAISE`; 0 = feature off |
| `auction.depositRateBps` | `depositRateBps` | 1000 (10%) | 100..5000 |

Admin override: `PATCH /admin/auctions/:id/deposit` `{ depositPaise: integer >= 0 | null }` (0 / null = no deposit, stored as null) -> `{ auction: { id, depositPaise } }`. 404 `AUCTION_NOT_FOUND`; 409 `AUCTION_ENDED` once the auction has ended or was cancelled. Editing the starting bid recomputes the deposit and replaces an override.

## Model

`AuctionDeposit { id, auctionId, memberId, amountPaise BigInt, status DepositStatus (PENDING | HELD | REFUNDED | FORFEITED, default PENDING), paymentOrderId? (unique), gatewayPaymentId?, refundId?, heldAt?, refundedAt?, forfeitedAt?, createdAt, updatedAt }`, `@@unique([auctionId, memberId])`, `@@index([status])`. Cascade on auction delete.

## Endpoint

| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/auctions/:id/deposit/checkout` | MEMBER, active | no body; payload as the sale / commission checkout `{ orderId, amountPaise, currency: 'INR', keyId, description, prefill }`. 404 `AUCTION_NOT_FOUND` (missing / cancelled), 409 `AUCTION_ENDED` (not open), 403 `OWN_AUCTION`, 409 `DEPOSIT_ALREADY_HELD`, 409 `DEPOSIT_NOT_REQUIRED` |

Checkout upserts the `AuctionDeposit` (PENDING, amount = the required amount), then creates a Razorpay order (`referenceType 'DEPOSIT'`, `referenceId` = deposit id, `idempotencyKey deposit:<id>:<orderId>`, receipt `d_<12 id chars>_<base36 time>`, notes `{ depositId, auctionId, memberId }`, no `transfers`). A CREATED order younger than 30 min for the same deposit and amount is reused.

Settlement: `POST /payments/verify` returns `{ referenceType: 'DEPOSIT', deposit: { id, auctionId, amountPaise, status, heldAt, refundedAt, forfeitedAt } }`; the webhook (`payment.captured` / `order.paid`, also found by the `depositId` note) calls the same `markDepositHeld`: one transaction, guarded `PENDING -> HELD` (`heldAt`, `paymentOrderId`, `gatewayPaymentId`), order marked PAID. A second delivery changes nothing and sends nothing. Notification `deposit-held` (`dedupeKey deposit-held:<depositId>`).

## Bid gate

`validateBid` and `validateBuyNow` take `deposit: { requiredPaise, held }` and, after the other pre-checks (suspended, not found, not started, ended, own auction), throw 403 `DEPOSIT_REQUIRED` (`details: { depositPaise }`, message "A refundable deposit is required to bid on this auction") when `requiredPaise > 0 && !held`. `lockAndLoad` in `bids.service.ts` loads the facts (`loadDepositFacts`: the member's deposit row, plus their active strike count unless the auction has its own deposit) inside the same transaction, after the auction row lock; the deposit rate setting is read before the transaction. A PENDING deposit is not held.

## Auction detail

`GET /auctions/:id` (and the bid / buy-now response) adds `depositPaise: number | null` and, for a signed-in viewer, `deposit: { requiredPaise, status: 'PENDING' | 'HELD' | 'REFUNDED' | 'FORFEITED' | null }` (null for guests).

## Release (hourly, `runDepositRelease`, part of `runSalesMaintenance`)

Batch of 100 HELD deposits whose auction is ENDED or CANCELLED / deleted, oldest first. Decision per deposit (`releaseDecision`):

| Situation | Result |
|---|---|
| auction CANCELLED / deleted | refund |
| auction ENDED, member is not the winner (or nobody won) | refund |
| winner, latest sale PAID or later (SHIPPED, DELIVERED, RELEASED, DISPUTED, REFUNDED) | refund |
| winner, latest sale CANCELLED (unpaid) | **forfeit**: FORFEITED + `forfeitedAt`, notification `deposit-forfeited` |
| winner, no Sale at all (legacy commission mode) | refund |
| winner, sale AWAITING_PAYMENT | wait |

Refund = `provider.refundPayment(gatewayPaymentId, { amountPaise, reverseAll: false })`, then a guarded `HELD -> REFUNDED` (`refundId`, `refundedAt`), notification `deposit-refunded`. A gateway failure leaves the deposit HELD, logs the error and retries on the next run. The counts `depositsRefunded` / `depositsForfeited` are part of the job result.

## Tests

`deposits/deposits.test.ts` (amount helpers, `DEPOSIT_REQUIRED` rules live in `auctions/bidding.rules.test.ts`, checkout rules, `markDepositHeld` idempotency, the release matrix incl. refund failure), `__tests__/http/bidding.http.test.ts` (`DEPOSIT_REQUIRED` over HTTP), `payments.service.test.ts` (DEPOSIT dispatch), `settings.test.ts`, guards / validation HTTP matrices.
