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
| Integer numbers (money in paise) | `Joi.number().integer().min(100).max(2_000_000_000)` |
| Regex | `.pattern(/^\d{6}$/)` (OTP code) |
| PATCH needs at least one field | `Joi.object(fields).min(1)` |
| Cross-field / domain rules | `.custom((v, helpers) => ok ? v : helpers.message({ custom: '...' }))` |
| Friendlier messages | `.messages({ 'any.only': 'contentType must be image/jpeg, image/png or image/webp' })` |

Shared rules live as plain functions so schemas, services and tests use one source: `passwordRuleError()` (`auth/password.ts`) and `checkTimeWindow()` (`auctions/auctions.validation.ts`, re-run by the service on PATCH when only one of the two times is sent).

Joi does not produce TypeScript types, so each validation file exports a matching type next to its schema (`CreateAuctionInput`, `ListQuery`, `PlaceBidInput`, `MyBidsQuery`, …) and the controller casts, e.g. `req.query as unknown as ListQuery`.

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
| `auth/auth.validation.ts` | `signupSchema`, `verifySignupSchema`, `resendSchema`, `forgotPasswordSchema`, `loginSchema`, `resetPasswordSchema`, `changePasswordSchema`, `deviceInfoSchema` | Signup `role` is `BIDDER` or `AUCTIONEER` only. New passwords go through `passwordRuleError` (8-72 bytes, a letter and a number); login only checks presence (1-1000). `code` is exactly 6 digits |
| `members/members.validation.ts` | `updateMeSchema` | `name` 1-200, `phone` ≤ 30, `address` ≤ 500, `avatarUrl` URI ≤ 1000; `''` / `null` clear a field; at least one field. The service also requires `avatarUrl` to be a platform upload |
| `uploads/uploads.validation.ts` | `presignSchema` | `folder` `auctions` \| `avatars`; `contentType` `image/jpeg` \| `image/png` \| `image/webp`; `size` 1 byte to 5 MB |
| `auctions/auctions.validation.ts` | `createAuctionSchema`, `updateAuctionSchema`, `republishSchema`, `listQuerySchema`, `mineQuerySchema` | `title` 5-120, `description` 20-10000 (sanitised by the service), `category` 1-100 (the service checks it against the configured categories), `condition` `NEW` \| `USED`, `images` 1-8 platform-upload URLs, `startingBidPaise` 100 to 2,000,000,000, optional `minIncrementPaise` from 100. Time window: `startTime` no more than 2 min in the past, `endTime` 1 h to 30 days after it. List: `status` `live` (default) \| `upcoming` \| `ended`, `category`, `sellerId`, `condition`, `q` ≤ 100, `minPrice` ≤ `maxPrice`, `sort` `endingSoon` \| `newest` \| `priceAsc` \| `priceDesc` \| `mostBids`, paging. Mine: `status` also allows `cancelled` |
| `bids/bids.validation.ts` | `placeBidSchema`, `listBidsQuerySchema`, `myBidsQuerySchema` | `amountPaise` integer 1 to 2,147,483,647 (INT4 ceiling; the bid rules enforce the real minimum). `tab` `winning` (default) \| `outbid` \| `won` \| `lost` |
| `watchlist/watchlist.validation.ts` | `listQuerySchema` | Paging only |
| `commissions/commissions.validation.ts` | `mineQuerySchema` | `status` `due` (default) \| `paid` \| `waived` \| `all`, paging |
| `payments/payments.validation.ts` | `verifySchema` | `orderId`, `paymentId` ≤ 100, `signature` ≤ 256 (Razorpay Checkout callback) |
| `push/push.validation.ts` | `subscribeSchema`, `unsubscribeSchema` | Exactly the browser's `PushSubscription.toJSON()`: `endpoint` (https-only URI, ≤ 2000), optional `expirationTime`, `keys.p256dh` / `keys.auth` (≤ 255). Unsubscribe is `{ endpoint }` |
| `contact/contact.validation.ts` | `contactSchema` | `name` 2-80, `email` ≤ 254, `subject` 3-120, `message` 10-4000 |
| `settings/settings.validation.ts` | `platformSettingsSchema`, `legalSlugParamSchema(slugs)`, `legalPageBodySchema` | Whole-object replace for `PUT /admin/settings`: `commissionRateBps` 0-3000, `minIncrementPaise` 100 to 2,000,000,000, `antiSnipingMinutes` 0-30, `categories` 1-30 names of 2-40 chars, unique ignoring case. Legal page: `title` 2-120, `content` 1-200,000 (sanitised by the service) |
| `admin/members/admin-members.validation.ts` | `listMembersQuery`, `updateMemberBody` | List: `status` `active` \| `inactive`, `role`, `q` ≤ 100, paging, `sortBy` allowlist + `sortOrder` (see `http.md`). Update: `isActive` and/or `role`, at least one |
| `admin/retention/admin-retention.validation.ts` | `purgeRetentionSchema` | Optional `otpChallengeDays`, `sessionInactiveDays`, each 1-365 |

Paging fields are the same everywhere: `page` integer ≥ 1 (default 1), `pageSize` 1-100 (default 20).

Schemas defined inline in their route file (still through `validate()`):

| Route file | Schema | Fields |
|---|---|---|
| `admin/auctions/admin-auctions.routes.ts` | `listQuerySchema` | `status` `live` \| `upcoming` \| `ended` \| `cancelled`, `q` ≤ 100, paging |
| `admin/commissions/admin-commissions.routes.ts` | `listQuerySchema` | `status` `due` (default) \| `paid` \| `waived` \| `all`, paging |
| `admin/payments/admin-payments.routes.ts` | `listQuerySchema` | `status` `created` \| `paid` \| `failed`, paging |
| `admin/settings/admin-settings.routes.ts` | `deviceLimitSchema` | `memberLimit`, `superAdminLimit`, each 1-20, both required |
| `notifications/notifications.routes.ts` | `listQuerySchema` | Paging only |
| `leaderboard/leaderboard.routes.ts` | `leaderboardQuerySchema` (exported) | `by` `spent` (default) \| `won`, `limit` 1-50 (default 20) |

`src/core/http/pagination.ts` also exports shared Joi pieces: `paginationSchema`, `offsetSchema`, `optionsQuerySchema`, `excludeIdsSchema` (none used by a route yet) and `sortOrderSchema` (used by `listMembersQuery`). See [http.md](./http.md).

## Joi-only rule

No Zod, no Yup. Every request validation uses `Joi` + the `validate()` middleware. Put a module's schemas in its `*.validation.ts`; the inline schemas above are small query schemas that live next to their only route.

---
*Last updated: 2026-11-15 (rewritten against the NobleBid modules: full schema table, inline route schemas, conventions taken from the real schemas)*
