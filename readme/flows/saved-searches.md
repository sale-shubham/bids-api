# Saved-search alerts flow

Code: `src/modules/saved-searches/saved-searches.{routes,controller,service,validation}.ts` and `saved-search.matcher.ts`. A bidder saves a browse filter and is notified when a matching auction is published.

## Schema

`SavedSearch { id, memberId -> Member (cascade), name?, q?, category?, condition ItemCondition?, minPricePaise BigInt?, maxPricePaise BigInt?, createdAt }`, indexes `(memberId)` and `(category)`.

## Endpoints (BIDDER, active member)

| Method | Path | Notes |
|---|---|---|
| GET | `/saved-searches` | `{ items }`, newest first |
| POST | `/saved-searches` | `{ name? <= 60, q? <= 100, category? (a category slug or name, stored under its canonical name when it resolves), condition? NEW\|LIKE_NEW\|GOOD\|FAIR\|USED\|FOR_PARTS, minPricePaise?, maxPricePaise? }` -> 201 `{ savedSearch }`. At least one of q / category / condition / min / max; `min <= max`; prices integers 0..`HARD_MAX_PRICE_PAISE`. Max 10 per member, else 409 `SAVED_SEARCH_LIMIT` |
| DELETE | `/saved-searches/:id` | own only, else 404 `NOT_FOUND` -> `{ id }` |

DTO `{ id, name, q, category, condition, minPricePaise, maxPricePaise (number|null), createdAt }`.

## Matching

Meaning follows the browse filters (`auctions.query.ts`): `q` = title contains (case-insensitive), price compares against the **starting bid** of a new listing.

`onAuctionPublished({ id, title, category, categoryId?, condition, startingBidPaise, sellerId })`:

1. One query for candidate searches: category null or one of the names / slugs of the auction's category and **all its ancestors** (so a search for a parent category matches its descendants; `categoryTerms` walks `parentId` from `categoryId`), condition null or equal, min null or `<=` price, max null or `>=` price, `memberId != seller`, member active.
2. In JS keep searches whose `q` is empty or whose every whitespace-separated word appears in the title (case-insensitive).
3. One `saved-search-match` notification per member (the oldest matching search names it), dedupe `ssm:<auctionId>:<memberId>`, url `/auctions/<id>`, `data { searchName }`, at most 500 members per auction.

### Follower alerts

After the saved-search pass, `onAuctionPublished` calls `notifyFollowers(auction, alreadyNotified)` (`follows.md`): type `followed-seller-listed`, dedupe `fsl:<auctionId>:<memberId>`, url `/auctions/<id>`, `data { sellerName }`, active followers only, at most 2,000 per auction, skipping members that just received a `saved-search-match` for the same auction in this run. The return value of `onAuctionPublished` is still the saved-search match count.

It is called best-effort (try/catch + logger) from `auctions.service.ts` right after `createAuction` and after a successful `republishAuction`; a failure never fails the request. The dedupe key means a republished auction does not notify the same member twice.

## Tests

`saved-searches/saved-searches.test.ts` (validation, limit, own delete, matcher word matching, filters, seller excluded, dedupe key, 500 cap), HTTP guards and validation matrices.
