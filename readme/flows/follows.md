# Follow a seller flow

Code: `src/modules/follows/follows.{routes,service,validation}.ts` (mounted at `/sellers`; `GET /members/me/following` is declared in `members.routes.ts`), fan-out in `src/modules/saved-searches/saved-search.matcher.ts` (`notifyFollowers`).

## Schema

`Follow { followerId -> Member ("Following", cascade), sellerId -> Member ("Followers", cascade), createdAt, @@id([followerId, sellerId]), @@index([sellerId]) }` and `Member.followerCount Int @default(0)`. The counter changes in the same transaction as the row (`createMany skipDuplicates` / `deleteMany`; only a real insert / delete moves it).

## Endpoints

| Method | Path | Guard | Notes |
|---|---|---|---|
| POST | `/sellers/:id/follow` | `authenticate`, `requireActiveMember` | -> `{ following: true, followerCount }`; idempotent. 400 `INVALID_FOLLOW` (yourself), 404 `SELLER_NOT_FOUND` (target is not an active MEMBER who has listed at least one auction, `listedCount > 0`; D17). The public profile carries `listedCount` so the app can hide the follow button |
| DELETE | `/sellers/:id/follow` | same | -> `{ following: false, followerCount }`; idempotent, same error rules |
| GET | `/members/me/following` | same | `?page&pageSize` (max 100) -> `paginated({ id, name, avatarUrl, verified, ratingAvg, ratingCount, activeAuctions, followedAt }[])`, newest follow first, inactive sellers hidden; `activeAuctions` = live auctions |
| GET | `/members/:id/public` | `optionalAuthenticate` | gains `followerCount` and `isFollowing` (false when anonymous) |

## Alerts

When a seller publishes (create / republish) `onAuctionPublished` runs the saved-search pass, then `notifyFollowers`: type `followed-seller-listed`, dedupe `fsl:<auctionId>:<memberId>`, url `/auctions/<id>`, `data { sellerName }`, active followers only (oldest first, at most 2,000 per auction), skipping members that already got a `saved-search-match` for the same auction in this run and the seller. Best-effort; a failure never fails the request. Members control the channels in `notification-preferences.md` (type label "A seller you follow listed an item", group Community).

## Tests

`follows/follows.test.ts` (rules, idempotency, counter, list, public profile), `saved-searches/saved-searches.test.ts` (fan-out cap / dedupe skip / inactive filter), HTTP guards and validation matrices.
