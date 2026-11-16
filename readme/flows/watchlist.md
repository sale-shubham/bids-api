# Watchlist flow

Code: `src/modules/watchlist/watchlist.{routes,service,validation}.ts`. Table `Watchlist` (`@@id([memberId, auctionId])`, `endingSoonNotifiedAt`). Any logged-in active member.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/watchlist` | `paginated({ addedAt, auction: AuctionCard }[])` (+ top-level `serverTime`). Live/upcoming first by endTime asc, then ended (most recently ended first). Cancelled auctions are hidden. Capped at the 500 newest watches, sorted in memory (the order depends on the computed effective status). |
| GET | `/watchlist/ids` | `{ ids: string[], activeCount }`: same ordering/hiding; `activeCount` = live + upcoming, for the nav badge. |
| POST | `/watchlist/:auctionId` | `{ watching: true }`. Idempotent (upsert). 404 `AUCTION_NOT_FOUND` for unknown/cancelled auctions. |
| DELETE | `/watchlist/:auctionId` | `{ watching: false }`. Idempotent. |

`GET /auctions/:id` carries `isWatching` and `watcherCount` (`auctions.md`).

## Ending-soon job

`runEndingSoon(now)` (`watchlist.service.ts`): watchlist rows with `endingSoonNotifiedAt = null` whose auction is effectively LIVE (not cancelled/ended, `startTime <= now < endTime`) and `endTime <= now + 60 min`. Rows where the watcher is the auction's own seller are marked handled (`endingSoonNotifiedAt = now`) and skipped, so a seller is never alerted about their own auction. For each other row, enqueue an `ending-soon` notification (in-app + email + push; templates `ending-soon.ejs` / `.txt.ejs`), then set `endingSoonNotifiedAt = now`. At most 1000 rows per run.

- dedupeKey: `ending-soon:<auctionId>:<memberId>:<endTime epoch ms>`. The end time is part of the key (a deviation from the plain `ending-soon:<auctionId>:<memberId>`) so that a republished auction, which gets a new endTime, can notify again; without it the old Notification row would swallow the new reminder. Re-runs within one cycle stay no-ops even if marking failed.
- Reset: `updateAuction` (times changed) and `republishAuction` clear `endingSoonNotifiedAt` for all watchers of the auction.
- Schedule: `index.js` `endingSoonHandler`; `serverless.yml` function `endingSoon` (`rate(15 minutes)`, timeout 60); the local dev server runs it every 5 minutes.
