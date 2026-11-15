# Strikes and second-chance offers flow

Code: `src/modules/strikes/` (`strikes.{rules,service,validation}.ts`), `src/modules/second-chance/` (`second-chance.{rules,service,routes}.ts`), `src/modules/admin/strikes/`, the unpaid-sale cancel in `src/modules/sales/sales.jobs.ts`. Decision: D12 in `docs/DECISIONS.md`. Deposits that follow from strikes: `deposits.md`.

## Strikes

A winner who does not pay in time gets a strike. `Strike { id, memberId, saleId (unique), reason StrikeReason (UNPAID), createdAt, expiresAt (+12 months), removedAt?, removedById?, note? }`, `@@index([memberId, expiresAt])`. **Active** = `removedAt` null and `expiresAt > now`.

When `runSalesMaintenance` cancels an AWAITING_PAYMENT sale past `payBy`, the cancel and the strike are written in ONE transaction (`createUnpaidStrike`), so a cancelled sale always has its strike and a repeated run does nothing. After commit (`applyStrikePolicy`, best effort), by the member's active count:

| Active strikes | Effect |
|---|---|
| 1 | notification `strike-issued` (warning) |
| 2 | `strike-issued` saying a deposit is now required on every bid (see `deposits.md`) |
| 3+ | `account-suspended` notification, then `Member.isActive = false`, the member's Sessions deleted and sockets disconnected (the same effects as the admin suspension) |

`account-suspended` is the only notification type delivered to an inactive member (`notify.service.ts`), so it is queued before the deactivation. Dedupe keys `strike-issued:<strikeId>`, `account-suspended:<strikeId>`.

`GET /members/me` (the member DTO) and the admin member DTO carry `activeStrikes: number`.

### Admin

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/members/:id/strikes` | `{ items: StrikeDTO[] }`, newest first; 404 for an unknown member |
| POST | `/admin/strikes/:id/remove` | `{ note? <= 500 }` -> `{ strike }`; sets `removedAt`, `removedById`, `note`. 404 `STRIKE_NOT_FOUND`, 409 `STRIKE_ALREADY_REMOVED`. Does **not** unsuspend the member: use `PATCH /admin/members/:id { isActive: true }` |

`StrikeDTO = { id, memberId, saleId, auction: { id, title } | null, reason, createdAt, expiresAt, removedAt, removedById, note, active }`.

## Several sales per auction

`Sale.auctionId` is no longer unique: `@@index([auctionId])` in Prisma plus a partial unique index in the migration SQL only, `CREATE UNIQUE INDEX "Sale_open_per_auction" ON "Sale"("auctionId") WHERE "status" NOT IN ('CANCELLED','REFUNDED')` (at most one open sale per auction; see `methods/prisma.md`: never `migrate dev`). Code that looked a sale up by auction uses the latest sale (`findFirst`, `createdAt desc`): auction detail `sale`, review eligibility, `GET /bids/mine` (`saleId`, `saleStatus`).

## Second-chance offers

After a sale is CANCELLED for non-payment the seller may offer the item to the runner-up.

`SecondChanceOffer { id, saleId (the cancelled sale, unique), auctionId, bidderId, amountPaise BigInt, status OfferStatus (PENDING | ACCEPTED | DECLINED | EXPIRED), expiresAt, respondedAt?, newSaleId?, createdAt }`, `@@index([bidderId, status])`.

| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/sales/:id/second-chance` | the seller (AUCTIONEER) | sale must be CANCELLED -> 201 `{ offer }`. 404 `SALE_NOT_FOUND`, 409 `SALE_INVALID_STATE` (not cancelled, or the auction already has an open sale), 409 `OFFER_EXISTS`, 409 `NO_RUNNER_UP` |
| GET | `/second-chance-offers/mine` | BIDDER | `{ items: OfferDTO[] }`, PENDING first |
| GET | `/second-chance-offers/:id` | the offered BIDDER | `{ offer }`; 404 `OFFER_NOT_FOUND` for anyone else |
| POST | `/second-chance-offers/:id/accept` | the offered BIDDER | `{ offer, saleId }`. 409 `OFFER_NOT_PENDING`, 409 `OFFER_EXPIRED`, 409 `PAYOUT_ACCOUNT_INACTIVE` |
| POST | `/second-chance-offers/:id/decline` | the offered BIDDER | `{ offer }`; 409 `OFFER_NOT_PENDING` |

- **Runner-up** (`findRunnerUp`, `pickRunnerUp`): per distinct bidder who is not a buyer of any sale on the auction and is an active member, their `MaxBid.maxAmountPaise` (fallback: their highest `Bid` row); the highest wins. The offer amount is that max. `expiresAt = now + 48 h`. Notification `second-chance-offer` (bidder, url `/purchases/offers/<offerId>`).
- **Accept**: one transaction creates the new Sale (AWAITING_PAYMENT, `payBy` +3 days, commission at the current `commission.rateBps`, amount = the offer), marks the offer ACCEPTED (guarded on PENDING and not expired) with `newSaleId`, sets `Auction.winnerId` to the bidder and moves the `auctionsWon` / `moneySpentPaise` counters from the cancelled buyer to the bidder. The seller needs an ACTIVE payout account (checkout mode), else 409 `PAYOUT_ACCOUNT_INACTIVE`. Notification `second-chance-accepted` to the seller. The buyer then pays through the normal sale checkout (`checkout.md`).
- **Decline**: PENDING -> DECLINED, notification `second-chance-declined` to the seller.
- **Expiry**: the hourly job moves PENDING offers past `expiresAt` to EXPIRED (`offersExpired` in the job result). `OfferDTO.status` already reads EXPIRED for a PENDING offer past its expiry.

`OfferDTO = { id, auctionId, auction: { id, title, coverImage }, amountPaise, status, expiresAt, respondedAt, newSaleId, createdAt }`. The seller's `SaleDTO` gains `secondChanceOffer: OfferDTO | null` and `canOfferSecondChance: boolean` (CANCELLED and no offer yet).

## Tests

`sales/sales.test.ts` (strike created in the cancel transaction, 1 / 2 / 3 strike thresholds, suspension effects), `strikes/strikes.test.ts` (rules, admin list / removal), `second-chance/second-chance.test.ts` (runner-up selection, offer exists / no runner-up, accept / decline / expiry), `admin.test.ts` (`activeStrikes`), guards / validation HTTP matrices.
