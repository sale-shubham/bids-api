# Seller analytics flow

Code: `src/modules/analytics/analytics.{routes,service,rules,validation}.ts`; the view endpoint is in `auctions.routes.ts` / `auctions.controller.ts`.

## Schema

- `AuctionStatDaily { auctionId -> Auction (cascade), date @db.Date, views, uniqueViewers, @@id([auctionId, date]) }`
- `AuctionViewer { auctionId, viewerKey, date @db.Date, @@id([auctionId, viewerKey, date]), @@index([date]) }` (no FK; purged by retention after 30 days)

Dates are Asia/Kolkata calendar days.

## View counting

`POST /auctions/:id/view` (`optionalAuthenticate`, `viewLimiter` = in-memory 120 per minute per IP, body `{}`) -> 204 always. `recordView` skips an unknown / deleted auction and the seller. `viewerKey` = sha256 of `m:<memberId>`, else `d:<dvid cookie>`, else `i:<ip>|<user-agent>`. One raw SQL statement: insert the `AuctionViewer` row `ON CONFLICT DO NOTHING`, then upsert the day's `AuctionStatDaily` with `views + 1` and `uniqueViewers + 1` only when the viewer row was new. The web app calls it once per auction page load (not part of `GET /auctions/:id`, which is cacheable).

## Endpoints (AUCTIONEER or SUPER_ADMIN, active member)

| Method | Path | Response |
|---|---|---|
| GET | `/analytics/seller?days=7\|30\|90` (default 30) | `{ range { from, to }, totals { views, uniqueViewers, watchers, bids, bidders, sold, revenuePaise }, daily [{ date, views, bids }], auctions [{ id, title, status, views, uniqueViewers, watchers, bids, bidders, currentBidPaise }] }` for the caller's auctions that were active or ended in the range (top 50 by views) |
| GET | `/analytics/auctions/:id?days=` | `{ auction { id, title, status }, totals { views, uniqueViewers, watchers, bids, bidders }, daily [{ date, views, uniqueViewers, bids }] }`; owner or SUPER_ADMIN, else 404 `NOT_FOUND` |

Notes: `range` is an inclusive IST day range ending today; `daily` is zero-filled. Views come from `AuctionStatDaily`, watchers (current count) from `Watchlist`, bids / bidders from `Bid` created in the range (AUTO bids count; `bidders` is distinct, also across auctions in the seller total). `uniqueViewers` in the seller totals is the sum of per-auction unique viewers (a person viewing two auctions counts twice). `sold` / `revenuePaise` = auctions with a winner that ended in the range and their final price.

## Retention

`runRetentionPurge` (daily `retentionPurge`, also `POST /admin/retention/purge`) deletes `AuctionViewer` rows older than 30 days (`auctionViewersDeleted`).

## Tests

`analytics/analytics.test.ts` (viewer key, IST ranges, new / repeat / seller / unknown view, aggregation shapes, owner check, viewer purge), HTTP guards and validation matrices.
