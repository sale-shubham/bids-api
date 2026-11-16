# Paid featured listings

Code: `src/modules/featured/` (`featured.rules`, `featured.service`, `featured.routes`, `featured.validation`), feeds in `src/modules/auctions/auctions.service.ts` (`homeFeed`, `promotedAuctions`).

## Rules

- Guard: `requireRole('MEMBER')` (SUPER_ADMIN gets 403) + owner check by member id.
- `Auction.featuredUntil` (nullable, indexed). Applying a purchase: `featuredUntil = min(max(now, current featuredUntil) + days, auction.endTime)`, so buying again extends a running feature and never runs past the end of the auction.
- `FeaturePurchase` (`PENDING | PAID | FAILED`, `paidWith` `RAZORPAY | CREDITS`, `amountPaise` BigInt). Seller history is `GET /auctions/:id/feature`.
- Settings: `featured.enabled` (default true) and `featured.prices` JSON `{ "1": 9900, "3": 24900, "7": 49900 }` paise (keys fixed). Public settings expose `featuredEnabled` and `featuredPrices`; `PUT /admin/settings` accepts both (optional, absent keeps the stored value).

## Endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/auctions/:id/feature/checkout` | MEMBER, active, owner (404 otherwise) | body `{ days: 1, 3 or 7, useCredits?: boolean }` |
| GET | `/auctions/:id/feature` | owner | `{ featuredUntil, purchases: [{ id, days, amountPaise, status, paidWith, paidAt, createdAt }] }` |
| GET | `/auctions/promoted?category=<slug>&limit=1..4` | public | `{ items: AuctionCard[] }`, live promoted only (category includes descendants), default limit 2 |

Errors: `409 AUCTION_ENDED` (ended or cancelled), `409 FEATURE_DISABLED`, `409 INSUFFICIENT_CREDITS` (only with `useCredits`), `404 AUCTION_NOT_FOUND` (also when not the owner), 400 validation.

## Payment

- Razorpay: creates a `PENDING` purchase and a `PaymentOrder` (`referenceType: 'FEATURE'`, no transfers; a CREATED order younger than 30 min for the same purchase is reused) and returns the standard checkout payload (`orderId, amountPaise, currency, keyId, description, prefill`). `/payments/verify` and the webhook dispatch to `markFeaturePaid` (one transaction, guarded `PENDING -> PAID`, so the listing is extended exactly once). Verify answers `{ referenceType: 'FEATURE', purchase }`.
- Credits: `useCredits: true` pays the whole price from the credit balance in one transaction (ledger debit `FEATURE_PURCHASE` under a member row lock, purchase `PAID`, listing extended) and answers `{ paidWithCredits: true, featuredUntil }`. A balance below the price is `409 INSUFFICIENT_CREDITS`; partial use is not supported (decision D15).
- After payment: the seller gets `feature-activated`; a `FEATURE` GST invoice is issued best-effort (`invoices.md`).

## Feeds

- `GET /auctions/home` `featured` = live auctions with `featuredUntil > now` first (soonest expiry first), filled up to 8 with the most-bids live list, no duplicates.
- Every auction card carries `promoted: boolean` (live and `featuredUntil > now`).

## Tests

`src/modules/featured/featured.test.ts`.
