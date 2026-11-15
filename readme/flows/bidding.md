# Bidding and auction closing flow

Code: `src/modules/bids/bids.{routes,controller,service,validation}.ts`, pure rules in `src/modules/auctions/bidding.rules.ts`, close job in `src/modules/auctions/auction-close.service.ts`, event hook in `src/modules/auctions/auction-events.ts`. Envelope as in `auctions.md`. Money is integer paise (DB `BigInt`, JSON / events plain numbers; see `readme/methods/prisma.md`).

## Endpoints

| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/auctions/:id/bids` | BIDDER only (others 403 `FORBIDDEN`) | body `{ amountPaise: int 1..1_000_000_000_000 }` (400 `PRICE_TOO_HIGH` with `details: { maxPaise }` above the admin ceiling `auction.maxPricePaise`, checked before the transaction) -> 201 `{ auction: AuctionDetail, bid: BidDTO, serverTime }` |
| GET | `/auctions/:id/bids` | public, optional auth | `paginated(BidDTO[])`, newest first; cancelled/deleted -> 404 unless seller / admin |
| GET | `/bids/mine` | BIDDER | `tab=winning\|outbid\|won\|lost` (default winning) + `page`/`pageSize` -> `paginated({ auction: AuctionCard, myHighestBidPaise, myBidCount, lastBidAt, state }[])` |

`BidDTO = { id, amountPaise, createdAt, bidderLabel, isMe }`. `bidderLabel` = first char + `***` + last char (`R***h`); 1-2 char names -> first char + `***`. `isMe` = requester is that bidder.

`/bids/mine` states come from the time-based effective status: live and I am highest = `WINNING`; live and not = `OUTBID`; ended and winner (`winnerId`, else `highestBidderId` until the close job stamps it) is me = `WON`, else `LOST`. Live tabs sort by `endTime` asc, ended tabs by `endTime` desc. Grouping and paging are in memory (a member's distinct auctions are few).

## Placing a bid (`placeBid`)

One interactive Prisma transaction (timeout 10 s):

1. `SELECT id FROM "Auction" WHERE id = $1 FOR UPDATE` (row lock; concurrent bids serialise, the second is validated against the first).
2. Re-read auction + bidder inside the lock, `now = new Date()` taken after the lock.
3. `validateBid` (pure), in order: `ACCOUNT_SUSPENDED` 403, `AUCTION_NOT_FOUND` 404 (cancelled / deleted), `AUCTION_NOT_STARTED` 409 (`now < startTime`), `AUCTION_ENDED` 409 (`now >= endTime` or stored ENDED), `OWN_AUCTION` 403, `ALREADY_HIGHEST` 409, `BID_TOO_LOW` 400 with `details: { minBidPaise }`. Minimum = `startingBidPaise` while `bidCount = 0`, else `currentBidPaise + minIncrementPaise`. Time checks never trust the stored status.
4. Insert `Bid`; update `currentBidPaise`, `highestBidderId`, `bidCount + 1`, `status = LIVE`.
5. Anti-sniping: AppSetting `auction.antiSnipingMinutes` N (0 / missing = off). If `endTime - now < N min` then `endTime = now + N min` (`antiSnipedEndTime`).

After commit (best effort, never fails the bid): `publishAuctionEvent` (`bid.placed`, plus `auction.extended` when the end moved), enqueue `outbid` for the previous highest bidder (`dedupeKey outbid:<bidId>:<memberId>`), then the response `AuctionDetail` is built.

Rate limits (`rateLimit.ts`, Pg-backed, per member): `bidAuctionLimiter` 10 per 10 s per member per auction, `bidMemberLimiter` 60 per minute per member. 429 `TOO_MANY_REQUESTS`.

## AuctionDetail additions

`recentBids: BidDTO[]` (latest 5, newest first), `myHighestBidPaise: number | null` (null for guests / no bids), `contact: { role: 'SELLER'|'WINNER', name, email, phone } | null`. `contact` only when the effective status is ENDED and there is a winner: the winner sees the SELLER, the seller sees the WINNER, anyone else null. Built by `auction-detail.service.ts` for `GET /auctions/:id` and the bid response. Create / patch / republish responses carry the empty defaults.

## Closing (`runAuctionClose(now)`)

Run every minute by the `closeAuctions` Lambda (EventBridge), by a 60 s `setInterval` in the local dev server, or manually with `npm run job:close`.

1. `SCHEDULED -> LIVE` where `startTime <= now < endTime`, not deleted.
2. Up to 5 batches of 50 auctions with `endTime <= now` and stored status SCHEDULED / LIVE. Each closes in its own transaction guarded by `updateMany WHERE id AND status IN (SCHEDULED, LIVE) AND endTime <= now`; 0 rows = no-op, so a second or concurrent run (or a bid that anti-sniped the end past `now`) does nothing. Sets `ENDED`, `endedAt`, `winnerId = highestBidderId` (null with no bids).
3. With bids: `Commission` (`rateBps` from AppSetting `commission.rateBps`, fallback `COMMISSION_RATE_BPS`; `amountPaise = round(currentBidPaise * rateBps / 10000)`; `DUE`; `dueAt = now + 7 days`), seller `unpaidCommissionPaise += amount`, winner `auctionsWon + 1`, `moneySpentPaise += currentBidPaise`.
4. After each commit: `publishAuctionEvent(auction.ended)` and notifications `auction-won`, `auction-sold`, `commission-due` (or `auction-unsold`). Returns `{ started, ended, sold, unsold }`.

## Real-time events

`publishAuctionEvent(event)` in `auction-events.ts` fans each event out over WebSocket (auction room + member-targeted outbid / won frames; never throws, see `websocket.md`). Events: `bid.placed { auctionId, currentBidPaise, bidCount, endTime, highestBidderId, previousHighestBidderId, bid: { id, amountPaise, createdAt, bidderLabel } }`, `auction.extended { auctionId, endTime }`, `auction.ended { auctionId, winnerId, finalBidPaise, bidCount, endedAt }`.
