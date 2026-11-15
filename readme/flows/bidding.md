# Bidding and auction closing flow

Code: `src/modules/bids/bids.{routes,controller,service,validation}.ts`, pure rules in `src/modules/auctions/bidding.rules.ts`, close job in `src/modules/auctions/auction-close.service.ts`, event hook in `src/modules/auctions/auction-events.ts`. Envelope as in `auctions.md`. Money is integer paise (DB `BigInt`, JSON / events plain numbers; see `readme/methods/prisma.md`).

## Endpoints

| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/auctions/:id/bids` | BIDDER only (others 403 `FORBIDDEN`) | body `{ maxAmountPaise: int 1..1_000_000_000_000 }`; `amountPaise` is accepted as a deprecated alias (the API deploys before the app), at least one is required, `max = maxAmountPaise ?? amountPaise`. 400 `PRICE_TOO_HIGH` (`details: { maxPaise }`) above the admin ceiling `auction.maxPricePaise`, checked before the transaction. 201 `{ auction: AuctionDetail, bid: BidDTO \| null, serverTime, outbidByProxy: boolean }` (`bid` = the requester's own new row, null when none was inserted) |
| POST | `/auctions/:id/buy-now` | BIDDER only | no body. 201 `{ auction: AuctionDetail, serverTime }`. Same middleware chain as the bid route |
| GET | `/auctions/:id/bids` | public, optional auth | `paginated(BidDTO[])`, newest first; cancelled/deleted -> 404 unless seller / admin |
| GET | `/bids/mine` | BIDDER | `tab=winning\|outbid\|won\|lost` (default winning) + `page`/`pageSize` -> `paginated({ auction: AuctionCard, myHighestBidPaise, myBidCount, myMaxBidPaise: number\|null, lastBidAt, state, canReview: boolean, saleId: string\|null, saleStatus: string\|null }[])` |

`BidDTO = { id, amountPaise, kind: 'MANUAL'|'AUTO'|'BUY_NOW', createdAt, bidderLabel, isMe }`. `bidderLabel` = first char + `***` + last char (`R***h`); 1-2 char names -> first char + `***`. `isMe` = requester is that bidder. `AUTO` rows are the proxy raising someone's price on their behalf.

`/bids/mine` states come from the time-based effective status: live and I am highest = `WINNING`; live and not = `OUTBID`; ended and the winner is me = `WON`, else `LOST`. The winner is `provisionalWinnerId`: the stamped `winnerId`, else (until the close job stamps it) the highest bidder **only when the reserve is met**, so an ended auction below its reserve gives its highest bidder `LOST`. `canReview` is computed for the returned page with one `Review` query by auction ids (see `reviews.md`). Live tabs sort by `endTime` asc, ended tabs by `endTime` desc. Grouping and paging are in memory (a member's distinct auctions are few).

## Max-bid model (eBay style; every bid is a maximum)

The bidder submits the most they are willing to pay. The system bids the minimum needed on their behalf. Each bidder's max is stored privately in `MaxBid` (`@@id([auctionId, bidderId])`, never exposed to other members; a viewer only ever gets their own `myMaxBidPaise`). `inc = minIncrementPaise`; the leader's effective max `L = their MaxBid ?? currentBidPaise` (a leader without a row, e.g. a pre-feature bid, bid exactly the current price). `resolveMaxBid` (pure, `bidding.rules.ts`) returns the `Bid` rows to insert, the new leader / price and `outbidByProxy`:

1. **First bid** (`bidCount = 0`): `max >= startingBidPaise` else `BID_TOO_LOW { minBidPaise }`. One `MANUAL` row at the starting bid; the max is not revealed.
2. **The requester is the leader:** `max > L` else 400 `MAX_TOO_LOW` (`details: { currentMaxPaise }`). No row (price unchanged), except the reserve jump.
3. **Challenger:** `max >= currentBid + inc` else `BID_TOO_LOW { minBidPaise }`.
   - `max > L`: if `L > currentBid` an `AUTO` row for the old leader at `L`; then a `MANUAL` row for the challenger at `min(max, L + inc)`; the challenger leads.
   - `max <= L`: `MANUAL` row for the challenger at `max`, then an `AUTO` row for the leader at `min(L, max + inc)`; the leader keeps the lead (ties go to the leader); `outbidByProxy = true`.
4. **Reserve jump:** when a reserve exists, the final leader's max is `>=` reserve and the final price is below it, the final price becomes the reserve (an extra `AUTO` row in case 2, the last row's amount raised in the others).
5. No amount ever exceeds that bidder's max and amounts are non-decreasing in row order.

## Reserve price (hidden)

`Auction.reservePricePaise` (null = none) is never sent to the public, bidders or in events. Everyone only sees `hasReserve` and `reserveMet` (`bidCount > 0 && currentBidPaise >= reserve`, or true when there is no reserve) on the card, and `reserveMet` on each `bid.placed` event. Only the seller and SUPER_ADMIN get `reservePricePaise` (see `auctions.md`). At close, an auction below its reserve is **not sold** (below).

## Buy It Now

`Auction.buyNowPricePaise` (null = off). Available only while `bidCount = 0`; the card shows `buyNowPricePaise: null` after the first bid. `POST /auctions/:id/buy-now` (`buyNow`) runs one locked transaction: `validateBuyNow` (same pre-checks as a bid, then 409 `BUY_NOW_UNAVAILABLE` when it is not set or a bid exists), insert a `BUY_NOW` `Bid` at the price, upsert the buyer's `MaxBid`, update the auction (`currentBidPaise`, `highestBidderId`, `bidCount = 1`, `status LIVE`, `endTime = now`), then `closeOneTx` (the same close logic as the job, in the same transaction: winner, commission, member stats). After commit it publishes `bid.placed` (`bid.kind = 'BUY_NOW'`), then `afterClose` (`auction.ended`, won / sold / commission notifications). Buy-now >= reserve is enforced at create / patch, so a buy-now always meets the reserve.

## Placing a bid (`placeBid`)

One interactive Prisma transaction (timeout 10 s):

0. Before the transaction: the `auction.maxPricePaise` check, the anti-sniping minutes and the deposit rate setting.
1. `SELECT id FROM "Auction" WHERE id = $1 FOR UPDATE` (row lock; concurrent bids serialise, the second is validated against the first).
2. Re-read auction + bidder inside the lock and load the bidder's deposit facts (`{ requiredPaise, held }`, `deposits.md`), `now = new Date()` taken after the lock; read the leader's `MaxBid`. `bidding.rules.ts` stays pure: the facts are passed in.
3. `validateBid` (pure pre-checks), in order: `ACCOUNT_SUSPENDED` 403, `AUCTION_NOT_FOUND` 404 (cancelled / deleted), `AUCTION_NOT_STARTED` 409 (`now < startTime`), `AUCTION_ENDED` 409 (`now >= endTime` or stored ENDED), `OWN_AUCTION` 403, `DEPOSIT_REQUIRED` 403 (`details: { depositPaise }`, when the bidder needs a deposit that is not HELD; `deposits.md`). Time checks never trust the stored status. Then `resolveMaxBid` judges the amount (`BID_TOO_LOW`, `MAX_TOO_LOW`). `ALREADY_HIGHEST` no longer exists: a leader bidding again raises their max.
4. Upsert the bidder's `MaxBid` to `max`; insert the rows in order (`bid.create` each, with `kind`); if any row: update `currentBidPaise`, `highestBidderId`, `bidCount + rows.length`, `status = LIVE`.
5. Anti-sniping, once per request when rows were inserted: AppSetting `auction.antiSnipingMinutes` N (0 / missing = off). If `endTime - now < N min` then `endTime = now + N min` (`antiSnipedEndTime`).

After commit (best effort, never fails the bid): one `bid.placed` event per inserted row in order (each carries the auction state after that row, see `websocket.md`), then `auction.extended` when the end moved. The `outbid` notification (`dedupeKey outbid:<lastBidId>:<memberId>`, `data.yourBidPaise` = that member's max) goes only to the member who **lost the lead in this request** (the previous leader when the requester took the lead; never the requester). A requester outbid by proxy gets no notification: `outbidByProxy: true` in the response tells them. After commit the shill-bid check (`checkBidRisk`, `risk.md`) runs best effort, then the response `AuctionDetail` is built (also after Buy It Now).

Errors of the bid / buy-now routes: `ACCOUNT_SUSPENDED` 403, `AUCTION_NOT_FOUND` 404, `AUCTION_NOT_STARTED` 409, `AUCTION_ENDED` 409, `OWN_AUCTION` 403, `DEPOSIT_REQUIRED` 403 (`{ depositPaise }`), `BID_TOO_LOW` 400 (`{ minBidPaise }`), `MAX_TOO_LOW` 400 (`{ currentMaxPaise }`), `PRICE_TOO_HIGH` 400 (`{ maxPaise }`), `BUY_NOW_UNAVAILABLE` 409.

Rate limits (`rateLimit.ts`, Pg-backed, per member): `bidAuctionLimiter` 10 per 10 s per member per auction, `bidMemberLimiter` 60 per minute per member (both on the bid and buy-now routes). 429 `TOO_MANY_REQUESTS`.

## AuctionDetail additions

`recentBids: BidDTO[]` (latest 5, newest first), `myHighestBidPaise: number | null` (null for guests / no bids), `myMaxBidPaise: number | null` (the viewer's own `MaxBid`), `reservePricePaise` (only for the seller / SUPER_ADMIN; absent otherwise), `depositPaise: number | null`, `deposit: { requiredPaise, status } | null` (the viewer's deposit, `deposits.md`), `contact: { role: 'SELLER'|'WINNER', name, email, phone } | null`. `contact` only when the effective status is ENDED and there is a winner: the winner sees the SELLER, the seller sees the WINNER, anyone else null. Built by `auction-detail.service.ts` for `GET /auctions/:id` and the bid response. Create / patch / republish responses carry the empty defaults.

## Closing (`runAuctionClose(now)`)

Run every minute by the `closeAuctions` Lambda (EventBridge), by a 60 s `setInterval` in the local dev server, or manually with `npm run job:close`.

1. `SCHEDULED -> LIVE` where `startTime <= now < endTime`, not deleted.
2. Up to 5 batches of 50 auctions with `endTime <= now` and stored status SCHEDULED / LIVE. Each closes in its own transaction guarded by `updateMany WHERE id AND status IN (SCHEDULED, LIVE) AND endTime <= now`; 0 rows = no-op, so a second or concurrent run (or a bid that anti-sniped the end past `now`) does nothing. Sets `ENDED`, `endedAt`. **Sold = `bidCount > 0` and the reserve is met** (`reserveMet`): then `winnerId = highestBidderId`; otherwise `winnerId` stays null.
3. When sold: `Commission` (`rateBps` from AppSetting `commission.rateBps`, fallback `COMMISSION_RATE_BPS`; `amountPaise = round(currentBidPaise * rateBps / 10000)`; `DUE`; `dueAt = now + 7 days`), seller `unpaidCommissionPaise += amount`, winner `auctionsWon + 1`, `moneySpentPaise += currentBidPaise`.
4. After each commit: `publishAuctionEvent(auction.ended)` and notifications `auction-won`, `auction-sold`, `commission-due` (or, when unsold, `auction-unsold`; if there were bids below the reserve the seller's `auction-unsold` has `data.reserveNotMet = true` and the highest bidder gets `reserve-not-met`, dedupe `reserve-not-met:<auctionId>:<endedAtMs>`). Below the reserve there is no winner, no commission and no member stats. Returns `{ started, ended, sold, unsold }`. The per-auction close is `closeOneTx(tx, auctionId, now, rateBps)`, shared with Buy It Now.

## Real-time events

`publishAuctionEvent(event)` in `auction-events.ts` fans each event out over WebSocket (auction room + member-targeted outbid / won frames; never throws, see `websocket.md`). Events: `bid.placed { auctionId, currentBidPaise, bidCount, endTime, highestBidderId, previousHighestBidderId, reserveMet, bid: { id, amountPaise, kind, createdAt, bidderLabel } }` (one per inserted row), `auction.extended { auctionId, endTime }`, `auction.ended { auctionId, winnerId, finalBidPaise, bidCount, endedAt }`.
