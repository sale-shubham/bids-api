# Reviews flow (seller ratings)

Code: `src/modules/reviews/reviews.{routes,controller,service,validation,rules}.ts`, admin side `src/modules/admin/reviews/`. Only the winner of an ended auction can rate the seller, once per auction.

## Schema

`Review { id, auctionId @unique -> Auction, sellerId -> Member ("ReviewsReceived"), reviewerId -> Member ("ReviewsWritten"), rating Int 1-5, comment String?, sellerReply String?, sellerRepliedAt?, hiddenAt?, createdAt, updatedAt }`, index `(sellerId, hiddenAt, createdAt)`. `Member.ratingCount` / `Member.ratingSum` (`Int`, default 0) count **non-hidden** reviews only. Migration `20261115190000_reviews_questions_saved_searches`.

## Endpoints

| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/auctions/:id/review` | MEMBER (active) | `{ rating: int 1..5, comment?: trimmed <= 1000 }` -> 201 `{ review: ReviewDTO }` |
| POST | `/reviews/:id/reply` | MEMBER / SUPER_ADMIN (active), must be the reviewed seller | `{ reply: trimmed 1..1000 }` -> `{ review }` |
| GET | `/members/:id/reviews` | public | `page`, `limit` (alias `pageSize`, max 100, default 20) -> `paginated(ReviewDTO[])`, non-hidden, newest first |
| GET | `/admin/reviews` | SUPER_ADMIN | see `admin.md` |
| PATCH | `/admin/reviews/:id` | SUPER_ADMIN | `{ hidden }`, see `admin.md` |

`ReviewDTO = { id, auctionId, auctionTitle, rating, comment|null, sellerReply|null, sellerRepliedAt|null, createdAt, reviewerLabel }`. `reviewerLabel` is `bidderLabel(name)` (`R***h`); the reviewer id is never exposed publicly.

## Rules

- The reviewer can never be the auction's seller (explicit check in `createReview`, 403 `REVIEW_NOT_ALLOWED`; with one MEMBER role a seller is also a buyer). The own-auction rule compares member ids, not roles.
- Eligible (`isReviewWindowOpen`, pure, `reviews.rules.ts`): the auction is effectively ENDED (not cancelled), `winnerId === me` (stamped by the close job, so an auction not yet closed is not reviewable), `endedAt` within the last 60 days. Otherwise 403 `REVIEW_NOT_ALLOWED`.
- **Checkout sales:** when the auction has a `Sale`, a review is allowed only when the sale is DELIVERED or RELEASED, and the 60-day window counts from `deliveredAt` (the release time when it was released without a delivery confirmation). `isReviewWindowOpen(auction, viewerId, now, sale?)` takes the sale; `createReview`, auction detail `canReview` and `GET /bids/mine` load it. Auctions without a Sale keep the rule above. See `checkout.md`.
- An existing review for the auction -> 409 `ALREADY_REVIEWED` (the unique violation of a concurrent create maps to the same code).
- One transaction: create the review and `ratingCount +1`, `ratingSum +rating` on the seller. Then notify the seller `review-received` (dedupe `review-received:<reviewId>`, url `/sellers/<sellerId>`).
- Reply: only the review's seller (any other member, SUPER_ADMIN included, gets 403 `FORBIDDEN`), once (409 `ALREADY_REPLIED`, race-safe via `updateMany` with `sellerReply: null`). 404 `REVIEW_NOT_FOUND`.
- `ratingAvg = round(ratingSum / ratingCount, 1)`, `null` when `ratingCount` is 0 (`ratingAvg()`); `ratingSum` is never exposed.

## Where the rating appears

- `GET /members/:id/public`: `ratingAvg`, `ratingCount`.
- Auction card / detail `seller`: `ratingAvg`, `ratingCount` (`sellerSelect` + serializer).
- Auction detail (`GET /auctions/:id`): `review: ReviewDTO | null` (non-hidden) and `canReview` (viewer is the eligible winner and no review exists).
- `GET /bids/mine` rows: `canReview`, computed for the page with one `Review` query by auction ids.

## Admin moderation

`PATCH /admin/reviews/:id { hidden }` sets / clears `hiddenAt` with a guarded `updateMany` and, only when the state actually changed, subtracts (hide) or adds back (unhide) the review from the seller's totals in the same transaction. Repeating the same value is a no-op.

## Tests

`reviews/reviews.test.ts` (eligibility, already reviewed, rating totals, reply once, admin hide / unhide math, `ratingAvg` rounding), HTTP guards and validation matrices.
