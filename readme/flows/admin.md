# Admin (SUPER_ADMIN only)

All routes are under `/admin` and require `authenticate` + `requireRole('SUPER_ADMIN')`. Code: `src/modules/admin/{dashboard,members,auctions,commissions,payments,settings,retention}`. Lists use `paginated()` (`meta: { total, page, pageSize, totalPages }`, `page` / `pageSize` max 100).

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/dashboard` | `{ totals: { members, bidders, auctioneers, liveAuctions, upcomingAuctions, endedAuctions, bidsToday, commissionPaidPaise, commissionDuePaise }, revenueByMonth: [{ month 'YYYY-MM', paidPaise }], signupsByMonth: [{ month, bidders, auctioneers }], recentAuctions: AuctionCard[5] }`. Both series cover the last 12 calendar months (IST), oldest first, zero-filled. Revenue = PAID commissions by `paidAt`. `bidsToday` counts from IST midnight. |
| GET | `/admin/members` | `q` (name/email/phone), `role`, `status=active\|inactive`, `sortBy`, `sortOrder`, paging -> `{ id, name, email, phone, role, isActive, emailVerifiedAt, createdAt, unpaidCommissionPaise, auctionsWon, moneySpentPaise }[]` + top-level `stats { total, active, inactive }` |
| PATCH | `/admin/members/:id` | `{ isActive?, role? }` (at least one) -> `{ member }`. 409 `CANNOT_MODIFY_SELF` if the target is the caller and the body changes role or sets `isActive: false`. Deactivation deletes the member's Sessions and force-disconnects their sockets. 404 for unknown id. |
| GET | `/admin/auctions` | `status=live\|upcoming\|ended\|cancelled` (omit = all), `q` (title, seller name/email) -> `AuctionCard & { sellerEmail }`, newest first. Cancel with `DELETE /auctions/:id` (admin may cancel auctions that have bids; no refund/notify, logged). |
| GET | `/admin/commissions` | `status=due\|paid\|waived\|all` (default due) -> `CommissionDTO & { seller: { id, name, email } }` |
| POST | `/admin/commissions/:id/waive` | `waiveCommission` -> `{ commission }`; 404 `COMMISSION_NOT_FOUND`, 409 `COMMISSION_NOT_DUE`; reduces the seller `unpaidCommissionPaise` (never below 0) |
| GET | `/admin/payments` | `status=created\|paid\|failed` (omit = all) -> `{ id, member: { id, name, email }, amountPaise, status (CREATED\|PAID\|FAILED), gatewayOrderId, gatewayPaymentId, referenceType, referenceId, createdAt }[]` |
| GET / PUT | `/admin/settings` | `{ commissionRateBps 0-3000, minIncrementPaise >= 100, antiSnipingMinutes 0-30, maxPricePaise 100000..1000000000000 (default 10000000000), categories: string[] }` (1-30 unique case-insensitive, each 2-40 chars). `maxPricePaise` is optional on PUT: when absent the stored value is kept. PUT replaces the rest of the object in one transaction and returns the whole object. Takes effect for new closes / bids / listings. |
| GET / PUT | `/admin/settings/legal[/:slug]` | see `legal-pages.md` |
| GET / PUT | `/admin/settings/device-limit` | per-role device cap |
| POST | `/admin/retention/purge` | manual retention purge |

Removed: `GET /admin/overview`, `POST /admin/members/:id/{activate,deactivate}`, `PATCH /admin/members/:id/role` (replaced by `/admin/dashboard` and `PATCH /admin/members/:id`).
