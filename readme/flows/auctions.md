# Auctions flow

Code: `src/modules/auctions/auctions.{routes,controller,service,validation,serializer,query}.ts`. Success envelope `{ success: true, data }`; errors `{ success: false, error: { code, message, details? } }`. Money is integer paise; dates are ISO strings.

## Effective status

Computed in `auctions.serializer.ts` `effectiveStatus()` from time; the stored `status` lags (the close job runs each minute) and is never trusted alone:

1. stored `CANCELLED` or `deletedAt` set -> `CANCELLED`
2. stored `ENDED` or `now >= endTime` -> `ENDED`
3. `now < startTime` -> `SCHEDULED`
4. otherwise `LIVE`

List filters (`auctions.query.ts` `statusWhere`) mirror this in SQL: live = `startTime <= now < endTime`, not cancelled/ended; upcoming = `startTime > now`; ended = `endTime <= now` or stored ENDED; cancelled (only `/auctions/mine`) = stored CANCELLED or deletedAt. Public lists never return cancelled/deleted rows.

## Shapes

`AuctionCard` = `{ id, title, category, condition: NEW|USED, coverImage|null, startingBidPaise, currentBidPaise, bidCount, startTime, endTime, status, seller: { id, name, avatarUrl } }`.
`AuctionDetail` = card + `{ description, images[], minIncrementPaise, highestBidderId|null, winnerId|null, endedAt|null, createdAt, updatedAt, recentBids: BidDTO[], myHighestBidPaise: number|null, contact: { role: 'SELLER'|'WINNER', name, email, phone }|null, isWatching: boolean, watcherCount: number }`. `isWatching` (false for guests) and `watcherCount` come from the Watchlist table (`watchlist.md`) and are `false` / `0` on create, patch and republish. The three extras before them are filled for `GET /auctions/:id` and the bid response (latest 5 bids newest first; the requester's highest bid; post-auction contact card for the winner / seller only) and are `[]` / `null` / `null` on create, patch and republish. See `bidding.md`.

## Endpoints

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/auctions` | public | query below -> `paginated(AuctionCard[])` |
| GET | `/auctions/home` | public | `{ featured[8], endingSoon[8], upcoming[8], serverTime }` (featured = live, most bids; endingSoon = live, soonest end; upcoming = soonest start) |
| GET | `/auctions/categories` | public | `{ categories: [{ name, liveCount }] }`, names + order from AppSetting `auction.categories` |
| GET | `/auctions/sitemap` | public | `{ items: [{ id, updatedAt }] }`: live + upcoming + ended in the last 90 days, never cancelled, max 5000, newest update first |
| GET | `/auctions/mine` | AUCTIONEER / SUPER_ADMIN | `status=upcoming\|live\|ended\|cancelled` (default live) + paging -> `paginated(AuctionCard[])` |
| GET | `/auctions/:id` | public, optional auth | `{ auction: AuctionDetail, serverTime }`; 404 `AUCTION_NOT_FOUND` if missing, or cancelled/deleted unless requester is the seller or SUPER_ADMIN |
| POST | `/auctions` | AUCTIONEER / SUPER_ADMIN | 201 `{ auction }` |
| PATCH | `/auctions/:id` | seller | all fields optional -> `{ auction }` |
| DELETE | `/auctions/:id` | seller / SUPER_ADMIN | soft delete -> `{ id }`. A SUPER_ADMIN may cancel any auction, including ones with bids (no refund or notification; it is logged). This is the admin cancel action. |
| POST | `/auctions/:id/republish` | seller | `{ startTime, endTime }` -> `{ auction }` |
| POST / GET | `/auctions/:id/bids` | BIDDER / public | place a bid / list bids; see `bidding.md` |

Fixed paths (`home`, `categories`, `sitemap`, `mine`) are declared before `/:id`.

### GET /auctions query

`status=live|upcoming|ended` (default `live`), `category`, `sellerId` (seller page), `condition=NEW|USED`, `q` (case-insensitive title contains, max 100), `minPrice`, `maxPrice` (paise, `minPrice <= maxPrice`), `sort=endingSoon|newest|priceAsc|priceDesc|mostBids`, `page` (default 1), `pageSize` (default 20, max 100).

Default sort: `endingSoon` (endTime asc) for live/upcoming; for ended, most recently ended first (endTime desc). `newest` = createdAt desc; `mostBids` = bidCount desc then endTime asc.

Price = `currentBidPaise` if `bidCount > 0` else `startingBidPaise` (the `GREATEST(current, starting)` value). `priceFilter()` applies min/max to that via an OR of the two cases. `priceAsc` / `priceDesc` cannot be an SQL ORDER BY in Prisma, so the service loads a 5-column projection of the filtered rows, sorts in memory, slices the page and loads those rows (TODO: raw SQL if the live catalogue grows large).

### Paginated response (exact) and where `serverTime` lives

```json
{
  "success": true,
  "data": [ /* AuctionCard[] */ ],
  "meta": { "total": 61, "page": 2, "pageSize": 20, "totalPages": 4 },
  "serverTime": "2026-11-14T10:00:00.000Z"
}
```

`serverTime` is a **top-level sibling of `data` and `meta`** (via the `extra` argument of `paginated()`), on both `GET /auctions` and `GET /auctions/mine`. `meta` is the standard `pageMeta()` (`totalPages >= 1`).

## Create / patch rules

| Field | Rule |
|---|---|
| `title` | 5-120 chars |
| `description` | HTML, 20-10000 chars raw; sanitised server-side (allow-list below); must still be >= 20 chars after sanitising |
| `category` | must be in AppSetting `auction.categories` (400 `VALIDATION_ERROR`) |
| `condition` | `NEW` / `USED` |
| `images` | 1-8 URLs, each under our CloudFront/S3 base (`isOwnMediaUrl`, same check as avatars); first = cover |
| `startingBidPaise` | int 100..2_000_000_000 |
| `minIncrementPaise` | optional int >= 100; default AppSetting `auction.minIncrementPaise` (10000 fallback) |
| `startTime` | ISO, `>= now - 2 min` (checked on create, republish, and on PATCH when `startTime` is sent) |
| `endTime` | `endTime - startTime` between 1 hour and 30 days (PATCH re-checks against the stored other time when only one is sent) |

Sanitiser (`sanitize-html`): tags `p br strong em u s ul ol li h2 h3 blockquote a`; `a` keeps `href` (http/https/mailto only) and always gets `rel="noopener noreferrer nofollow" target="_blank"`; everything else (scripts, handlers, images, styles) is dropped.

Stored `status` on create/republish: `LIVE` if `startTime <= now`, else `SCHEDULED`. PATCH moving `startTime` into the future resets it to `SCHEDULED`.

## Ownership and error codes

| Status | `code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Joi failure, unknown category, time window broken against stored times |
| 403 | `FORBIDDEN` | role is not AUCTIONEER / SUPER_ADMIN on create / mine / write routes |
| 403 | `COMMISSION_UNPAID` | create while `unpaidCommissionPaise > 0` |
| 404 | `AUCTION_NOT_FOUND` | missing; cancelled for non-privileged viewers; PATCH / republish by a non-owner (even SUPER_ADMIN); DELETE by a non-owner non-admin |
| 409 | `AUCTION_HAS_BIDS` | PATCH or seller DELETE when `bidCount > 0` (checked first on PATCH) |
| 409 | `AUCTION_ENDED` | PATCH when effective status is ENDED / CANCELLED |
| 409 | `AUCTION_NOT_REPUBLISHABLE` | republish unless effective ENDED and `bidCount = 0` |

Writes use `updateMany` with `bidCount: 0` in the WHERE, so a bid landing between the check and the write cannot be overwritten (the call then returns `AUCTION_HAS_BIDS`).

DELETE = soft delete: `status = CANCELLED`, `deletedAt = now`. SUPER_ADMIN may delete regardless of bids (and any seller's auction). Republish sets the new times and status, clears `endedAt`, `winnerId`, `highestBidderId`.

Rate limit: `auctionWriteLimiter` (10 / min per member) on create, patch, republish.

## Uploads hardening

`presignPut(key, type, size)` signs `ContentType` and `ContentLength` into the URL, so S3 rejects a PUT whose body size or type differs from what was declared to `POST /uploads/presign` (cap stays 5 MB).

## Demo data

`npm run seed:demo` (run manually) creates `demo.seller@noblebid.local` (AUCTIONEER, random password printed once) and 12 auctions (6 live, 3 upcoming, 3 ended) with `https://picsum.photos/seed/noblebid-<n>/800/600` images. Idempotent on that email. These picsum URLs are not under our media base, so a PATCH that sends `images` for a demo auction fails the image check (other fields are fine).

## Ending-soon reset

`updateAuction` (when times change) and `republishAuction` call `resetEndingSoon(auctionId)` so watchers can be reminded again. See `watchlist.md`.
