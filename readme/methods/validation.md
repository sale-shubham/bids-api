# Validation

## validate() middleware

`src/core/middleware/validate.ts`

```typescript
validate(schema: Joi.Schema, source: 'body' | 'query' | 'params' = 'body'): RequestHandler
```

- Validates `req[source]` against Joi schema
- Options: `abortEarly: false`, `convert: true`, `stripUnknown: true`
- On error: 400 + `{ success: false, error: { code: 'VALIDATION_ERROR', message: string, details: [{ field, message }] } }` (matches the standard `errorHandler` envelope). `field` is the Joi path joined with `.`; quotes are stripped from each message; `message` joins every `field: message` pair with `; `.
- On success: overwrites `req[source]` with converted/stripped value (via `Object.defineProperty`, since Express 5's `req.query` is a getter). So a handler reads typed values: `page` is a number, defaults are filled in, `Joi.date()` fields are `Date` objects.

## Schema conventions

| Rule | Example |
|---|---|
| Strings trimmed | `.trim()` |
| Emails lowercased | `Joi.string().trim().lowercase().email({ tlds: { allow: false } }).max(254)` (auth); contact uses `.email()` |
| Enums | `Joi.string().valid('NEW', 'USED')`, `.valid(...BID_TABS)` |
| Optional / clearable fields | `.optional()`, or `.allow('', null)` where an empty value clears it (`PATCH /members/me`) |
| Default values | `.default(20)`, `.default('live')` |
| Integer numbers (money in paise) | `Joi.number().integer().min(100).max(HARD_MAX_PRICE_PAISE)` (`src/core/money.ts`, 1,000,000,000,000) |
| Regex | `.pattern(/^\d{6}$/)` (OTP code) |
| PATCH needs at least one field | `Joi.object(fields).min(1)` |
| Cross-field / domain rules | `.custom((v, helpers) => ok ? v : helpers.message({ custom: '...' }))` |
| Friendlier messages | `.messages({ 'any.only': 'contentType must be image/jpeg, image/png or image/webp' })` |

Shared rules live as plain functions so schemas, services and tests use one source: `passwordRuleError()` (`auth/password.ts`) and `checkTimeWindow()` (`auctions/auctions.validation.ts`, re-run by the service on PATCH when only one of the two times is sent).

Joi does not produce TypeScript types, so each validation file exports a matching type next to its schema (`CreateAuctionInput`, `ListQuery`, `PlaceBidInput`, `MyBidsQuery`, …) and the controller casts, e.g. `req.query as unknown as ListQuery`.

Other Phase F schemas: `categories/categories.validation.ts` (`createCategorySchema`, `updateCategorySchema`: `name` <= 60, `slug` lower-case hyphenated <= 60, `parentId` nullable, `sortOrder`, `isActive`, `description` <= 500, `attributeSchema` <= 30 defs with unique keys, key `/^[a-z][a-z0-9_]{0,39}$/`, `options` 1..50 for `select` only, `unit` <= 12); `uploads/uploads.validation.ts` `presignSchema` (folder decides the allowed types and size: `auction-videos` = `video/mp4` / `video/webm` up to 50 MB, `auctions` / `avatars` = images up to 5 MB); `sales/sales.validation.ts` `checkoutSchema` (optional `delivery` `COURIER` \| `PICKUP`). Pure rule functions: `validateAttributes` (`categories.rules.ts`), `assertEstimate` / `validateShipping` (`auctions/listing.rules.ts`).

## Per-source usage

```typescript
// Body (default)
router.post('/', ...seller, auctionWriteLimiter, validate(createAuctionSchema), asyncHandler(ctrl.create));

// Query string
router.get('/', validate(listQuerySchema, 'query'), asyncHandler(ctrl.list));

// URL params, then body
router.put(
  '/legal/:slug',
  validate(legalSlugParamSchema(LEGAL_PAGE_SLUGS), 'params'),
  validate(legalPageBodySchema),
  asyncHandler(handler),
);
```

`validate()` runs after the auth guards and rate limiters on a route, so an unauthenticated call gets 401 before any 400. Most `:id` params have no schema: the id is passed to the service as a string, and an unknown id answers 404 (`AUCTION_NOT_FOUND`, `COMMISSION_NOT_FOUND`, …). The legal-page `:slug` is the exception: unknown slugs are a 400.

## Schemas

| File | Schemas | Notes |
|---|---|---|
| `auth/auth.validation.ts` | `signupSchema`, `verifySignupSchema`, `resendSchema`, `forgotPasswordSchema`, `loginSchema`, `resetPasswordSchema`, `changePasswordSchema`, `deviceInfoSchema` | Signup has no `role` (an old client's `role` is stripped by `validate()`; the account is always a `MEMBER`). New passwords go through `passwordRuleError` (8-72 bytes, a letter and a number); login only checks presence (1-1000). `code` is exactly 6 digits |
| `members/members.validation.ts` | `updateMeSchema` | `name` 1-200, `phone` ≤ 30, `address` ≤ 500, `avatarUrl` URI ≤ 1000; `''` / `null` clear a field; at least one field. The service also requires `avatarUrl` to be a platform upload |
| `uploads/uploads.validation.ts` | `presignSchema` | `folder` `auctions` \| `avatars`; `contentType` `image/jpeg` \| `image/png` \| `image/webp`; `size` 1 byte to 5 MB |
| `auctions/auctions.validation.ts` | `createAuctionSchema`, `updateAuctionSchema`, `republishSchema`, `bulkCreateSchema`, `listQuerySchema`, `mineQuerySchema` | `title` 5-120, `description` 20-10000 (sanitised by the service), `categoryId` or the legacy `category` (one required on create, `.or()`; the service resolves it to an active `Category`, 400 `INVALID_CATEGORY`), `attributes` object (shape checked by the pure `validateAttributes`, 400 `INVALID_ATTRIBUTES`), `condition` one of `NEW` / `LIKE_NEW` / `GOOD` / `FAIR` / `USED` / `FOR_PARTS` (`CONDITIONS` in `listing.rules.ts`, shared with saved searches), `conditionReport` <= 20,000 raw (<= 5,000 after sanitising, service), `estimateLowPaise` / `estimateHighPaise` (service: 400 `INVALID_ESTIMATE`), `videoUrl` platform upload, `shippingOptions` object (pure `validateShipping`, 400 `INVALID_SHIPPING`), `images` 1-8 platform-upload URLs, `startingBidPaise` 100 to `HARD_MAX_PRICE_PAISE`, optional `minIncrementPaise` 100 to `HARD_MAX_PRICE_PAISE`, optional `reservePricePaise` / `buyNowPricePaise` 100 to `HARD_MAX_PRICE_PAISE` (nullable; the service enforces `INVALID_RESERVE` / `INVALID_BUY_NOW` against the stored starting bid, and the admin ceiling; see `auctions.md`) (the service also enforces the admin ceiling `auction.maxPricePaise`, 400 `PRICE_TOO_HIGH`). Time window: `startTime` no more than 2 min in the past, `endTime` 1 h to 30 days after it. List: `status` `live` (default) \| `upcoming` \| `ended`, `category`, `sellerId`, `condition`, `q` ≤ 100, `minPrice` ≤ `maxPrice`, `sold`, `sort` `endingSoon` \| `newest` \| `priceAsc` \| `priceDesc` \| `mostBids` \| `recentlySold`, up to 5 `attr.<key>` params (pattern keys, each <= 200 chars; the schema's `custom()` moves them into `attrs`), paging. Bulk: `{ items }` 1..50 objects, each validated with `createAuctionSchema` in the service so errors are per row (400 `BULK_INVALID`). Mine: `status` also allows `cancelled` |
| `bids/bids.validation.ts` | `placeBidSchema`, `listBidsQuerySchema`, `myBidsQuerySchema` | `maxAmountPaise` or the deprecated alias `amountPaise` (`Joi.object().or(...)`, at least one), each integer 1 to `HARD_MAX_PRICE_PAISE` (`resolveMaxBid` enforces the real minimum, `placeBid` the admin ceiling). `POST /auctions/:id/buy-now` has no body, so no schema. `tab` `winning` (default) \| `outbid` \| `won` \| `lost` |
| `watchlist/watchlist.validation.ts` | `listQuerySchema` | Paging only |
| `commissions/commissions.validation.ts` | `mineQuerySchema` | `status` `due` (default) \| `paid` \| `waived` \| `all`, paging |
| `payments/payments.validation.ts` | `verifySchema` | `orderId`, `paymentId` ≤ 100, `signature` ≤ 256 (Razorpay Checkout callback) |
| `push/push.validation.ts` | `subscribeSchema`, `unsubscribeSchema` | Exactly the browser's `PushSubscription.toJSON()`: `endpoint` (https-only URI, ≤ 2000), optional `expirationTime`, `keys.p256dh` / `keys.auth` (≤ 255). Unsubscribe is `{ endpoint }` |
| `reviews/reviews.validation.ts` | `createReviewSchema`, `replySchema`, `reviewListQuerySchema` | `rating` integer 1-5, `comment` trimmed ≤ 1000 (optional, `''` stored as null); `reply` trimmed 1-1000; list: `page`, `limit` (alias `pageSize`) max 100 |
| `questions/questions.validation.ts` | `askQuestionSchema`, `answerQuestionSchema` | `question` trimmed 5-500; `answer` trimmed 1-1000 |
| `saved-searches/saved-searches.validation.ts` | `createSavedSearchSchema` | `name` ≤ 60, `q` ≤ 100, `category` ≤ 100, `condition` `NEW` \| `USED`, `minPricePaise` / `maxPricePaise` integer 0 to `HARD_MAX_PRICE_PAISE`; at least one of q / category / condition / min / max; min ≤ max |
| `admin/reviews/admin-reviews.validation.ts` | `listReviewsQuery`, `hideReviewBody` | `hidden` boolean, `q` ≤ 100, paging; body `{ hidden }` required |
| `contact/contact.validation.ts` | `contactSchema` | `name` 2-80, `email` ≤ 254, `subject` 3-120, `message` 10-4000 |
| `settings/settings.validation.ts` | `platformSettingsSchema`, `legalSlugParamSchema(slugs)`, `legalPageBodySchema` | Whole-object replace for `PUT /admin/settings`: `commissionRateBps` 0-3000, `minIncrementPaise` 100 to `HARD_MAX_PRICE_PAISE`, `antiSnipingMinutes` 0-30, optional `maxPricePaise` 100,000 to `HARD_MAX_PRICE_PAISE` (absent keeps the stored value), optional, ignored `categories` (1-30 names of 2-40 chars, unique ignoring case). Legal page: `title` 2-120, `content` 1-200,000 (sanitised by the service) |
 Also optional: `depositThresholdPaise` 0..HARD_MAX (0 = off), `depositRateBps` 100..5000.
| `admin/members/admin-members.validation.ts` | `listMembersQuery`, `updateMemberBody` | List: `status` `active` \| `inactive`, `seller` boolean (`true` = has listed an auction), `q` ≤ 100, paging, `sortBy` allowlist + `sortOrder` (see `http.md`). Update: `isActive` and/or `verified`, at least one (`role` is stripped) |
| `admin/retention/admin-retention.validation.ts` | `purgeRetentionSchema` | Optional `otpChallengeDays`, `sessionInactiveDays`, each 1-365 |

Paging fields are the same everywhere: `page` integer ≥ 1 (default 1), `pageSize` 1-100 (default 20).

Schemas defined inline in their route file (still through `validate()`):

| Route file | Schema | Fields |
|---|---|---|
| `admin/auctions/admin-auctions.routes.ts` | `listQuerySchema` | `status` `live` \| `upcoming` \| `ended` \| `cancelled`, `q` ≤ 100, paging |
| `admin/commissions/admin-commissions.routes.ts` | `waiveBodySchema` | optional body, `note` trimmed 3-200 chars (defaults to `{}`) |
| `admin/commissions/admin-commissions.routes.ts` | `listQuerySchema` | `status` `due` (default) \| `paid` \| `waived` \| `all`, paging |
| `admin/payments/admin-payments.routes.ts` | `listQuerySchema` | `status` `created` \| `paid` \| `failed`, paging |
| `admin/settings/admin-settings.routes.ts` | `deviceLimitSchema` | `memberLimit`, `superAdminLimit`, each 1-20, both required |
| `admin/reports/admin-reports.routes.ts` | `adminListReportsQuery` / `resolveReportBody` (`reports.validation.ts`) | `status`, `targetType`, paging; `status` ACTION_TAKEN \| DISMISSED, `note` <= 500, `applyToAllOpenForTarget` |
| `admin/auctions/admin-auctions.routes.ts` | `depositBodySchema` (inline) | `PATCH /admin/auctions/:id/deposit`: `depositPaise` integer 0..HARD_MAX or null, required |
| `strikes/strikes.validation.ts` | `removeStrikeBody` | `POST /admin/strikes/:id/remove`: `note` <= 500 (optional) |
| `admin/risk/admin-risk.validation.ts` | `listRiskQuery` / `reviewRiskBody` | `status` open \| reviewed (default open), paging (`pageSize` <= 100); `outcome` DISMISSED \| ACTION_TAKEN required, `note` <= 500 |
| `notifications/notifications.routes.ts` | `listQuerySchema` | Paging only |
| `leaderboard/leaderboard.routes.ts` | `leaderboardQuerySchema` (exported) | `by` `spent` (default) \| `won`, `limit` 1-50 (default 20) |

`src/core/http/pagination.ts` also exports shared Joi pieces: `paginationSchema`, `offsetSchema`, `optionsQuerySchema`, `excludeIdsSchema` (none used by a route yet) and `sortOrderSchema` (used by `listMembersQuery`). See [http.md](./http.md).

## Joi-only rule

No Zod, no Yup. Every request validation uses `Joi` + the `validate()` middleware. Put a module's schemas in its `*.validation.ts`; the inline schemas above are small query schemas that live next to their only route.

---
*Last updated: 2026-11-15 (rewritten against the NobleBid modules: full schema table, inline route schemas, conventions taken from the real schemas)*
