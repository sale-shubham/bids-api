# Leaderboard and seller pages

Code: `src/modules/leaderboard/leaderboard.{routes,service}.ts`, `members.service.ts`. Public seller profile (`getPublicProfile`) adds `listedCount` (auctions ever created, all statuses) next to `role`.

## GET /leaderboard (public)

Query `by=spent|won` (default `spent`), `limit` (default 20, max 50). Response `{ entries: [{ rank, member: { id, displayName, avatarUrl }, auctionsWon, moneySpentPaise }] }`.

- MEMBERs (`role = MEMBER`), active, and with `auctionsWon > 0` or `moneySpentPaise > 0` (zero activity is excluded).
- Order: `spent` = moneySpentPaise desc, auctionsWon desc; `won` = auctionsWon desc, moneySpentPaise desc; ties by signup date then id. `rank` is the 1-based position.
- `displayName` = first name + last initial ("Rahul Sharma" -> "Rahul S."); a single name is kept as is. Full names and emails are never returned.

## GET /members/:id/public

Returns the member object directly in `data`: `{ id, name, avatarUrl, role, createdAt, auctionsSold, activeAuctions }`. `auctionsSold` = the seller's ended auctions that received bids; `activeAuctions` = their currently live auctions. Their listings come from `GET /auctions?sellerId=<id>`.
