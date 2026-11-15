# HTTP Utilities

## Route params — `param(req, name)` (`src/core/http/params.ts`)

Read a named route param with `param(req, 'id')`, never `req.params.id`. Express 5's types widen every param to `string | string[]` (a wildcard like `/*splat` captures an array), so `req.params.x` no longer type-checks where a `string` is expected. `param()` returns the string and throws `BadRequest` (400) if the value is missing or an array — no route here uses a wildcard, so that only fires on a routing bug. Covered by `params.test.ts` against a real Express 5 router.

Express 5 route patterns (path-to-regexp v8): wildcards must be named (`/*splat`), optional segments use braces (`/items{/:id}`), and regex/`?`/`+` patterns are gone. `req.query` is a read-only getter — `validate()` replaces it with `Object.defineProperty`, never assignment.

Fixed paths are declared before `/:id` so they are never read as an id: `/auctions/home`, `/categories`, `/sitemap` and `/mine` come before `/auctions/:id`; `/watchlist/ids` before `/watchlist/:auctionId`; `/members/me` before `/members/:id/public`. Bids are mounted as a child router (`auctionBidsRouter`, `mergeParams: true`) at `/auctions/:id/bids`, so `param(req, 'id')` there is the auction id.

## AppError

`src/core/errors/AppError.ts`

```typescript
class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) { ... }
}
```

Throw for expected, user-facing errors. `errorHandler` converts to JSON response. Factory helpers: `BadRequest` (400 `BAD_REQUEST`), `Unauthorized` (401 `UNAUTHORIZED`), `Forbidden` (403 `FORBIDDEN`), `NotFound` (404 `NOT_FOUND`), `Conflict` (409 `CONFLICT`), `UnprocessableEntity` (422 `UNPROCESSABLE_ENTITY`), `TooManyRequests` (429 `TOO_MANY_REQUESTS`), `ServiceUnavailable` (503 `SERVICE_UNAVAILABLE`). Only `BadRequest`, `Conflict` and `UnprocessableEntity` take `details`.

When the frontend needs to tell one failure from another, throw `new AppError(status, 'SPECIFIC_CODE', message)` instead of a generic helper. Examples in the code: `AUCTION_NOT_FOUND` (404), `BID_TOO_LOW` (400, `details` carries the minimum acceptable bid), `ALREADY_HIGHEST`, `AUCTION_ENDED`, `AUCTION_HAS_BIDS` (409), `OWN_AUCTION`, `COMMISSION_UNPAID`, `ACCOUNT_SUSPENDED`, `EMAIL_NOT_VERIFIED` (403), `COMMISSION_NOT_DUE`, `CANNOT_MODIFY_SELF` (409), `INVALID_CREDENTIALS` (401).

## Response helpers

`src/core/http/response.ts`

```typescript
ok(res, data, status = 200)
// → { success: true, data }

paginated(res, items, meta, extra?)
// meta: { nextCursor?, total?, page?, pageSize?, totalPages? }
// → { success: true, data: items, meta, ...extra }
```

`extra` adds top-level siblings of `data` / `meta`: `GET /auctions`, `/auctions/mine`, `/watchlist` and `/admin/auctions` add `serverTime` (ISO string, so the client can run countdowns against server time); `GET /admin/members` adds `stats` (`{ total, active, inactive }`). Created resources answer `ok(res, data, 201)` (e.g. `POST /auctions`, `POST /auctions/:id/bids`).

Always use these — never `res.json()` directly in route handlers. The one exception is `GET /health` in `src/routes.ts`, which writes the same envelope by hand.

## asyncHandler

`src/core/middleware/asyncHandler.ts`

```typescript
asyncHandler(fn: (req, res, next) => Promise<unknown>): RequestHandler
```

Wraps async route handler. Forwards thrown errors to Express `next`. Use on every async handler.

Handlers lazy-load their service and the response helpers with dynamic `import()` inside the handler body (Lambda cold start), e.g.:

```typescript
export async function list(req: Request, res: Response) {
  const { paginated } = await import('@/core/http/response');
  const svc = await import('./auctions.service');
  const { items, meta } = await svc.listAuctions(req.query as unknown as ListQuery);
  return paginated(res, items, meta, { serverTime: new Date().toISOString() });
}
```

## Pagination

`src/core/http/pagination.ts`

Every list endpoint uses **offset** paging (page numbers). The file also holds a keyset helper and opt-in "options" helpers that no endpoint uses yet.

### Offset (page-numbers)

```typescript
offsetSchema  // Joi: { page: int>=1 (default 1), pageSize: int 1-100 (default 20), q?: string }
offsetArgs({ page, pageSize })      // → { skip: (page-1)*pageSize, take: pageSize }
pageMeta(total, { page, pageSize }) // → { total, page, pageSize, totalPages }  (totalPages >= 1)
```

Each module declares the same `page` / `pageSize` fields in its own Joi schema (min 1 / 1-100, defaults 1 / 20) next to its filters, rather than extending `offsetSchema`. The service runs `findMany({ where, orderBy, ...offsetArgs(q) })` + `count({ where })` in a `Promise.all` and returns `{ items, meta: pageMeta(total, q) }`; the controller responds `paginated(res, items, meta)`. Free-text `q` filters with `{ contains: q, mode: 'insensitive' }`: auction `title` on `GET /auctions`; title, seller email or seller name on `GET /admin/auctions`; name, email or phone on `GET /admin/members`.

Where the order depends on a computed value Prisma cannot `ORDER BY`, the service sorts in memory and slices with `offsetArgs`, then builds `pageMeta` from the in-memory length: `GET /auctions?sort=priceAsc|priceDesc` (price = current bid if any, else starting bid), `GET /watchlist` (live and upcoming first, by computed status) and `GET /bids/mine` (grouped per auction, filtered by tab).

Adopters: `GET /auctions`, `/auctions/mine`, `/auctions/:id/bids`, `/bids/mine`, `/watchlist`, `/notifications`, `/commissions/mine`, `/admin/auctions`, `/admin/members`, `/admin/commissions`, `/admin/payments`. `GET /leaderboard` is not paged: it takes `limit` (1-50, default 20).

### Column sort (`sortBy`/`sortOrder`)

```typescript
sortOrderSchema  // Joi: 'asc' | 'desc', optional — the shared half; sortBy itself is validated per-module

buildOrderBy(sortBy, sortOrder, sortMap, fallback)
// sortMap: Record<string, (order: SortOrder) => PrismaOrderByFragment>
// → sortMap[sortBy]?.(order) ?? fallback   (order defaults to 'asc')
```

Turns a table-header sort click into a real Prisma `orderBy` applied **before** the `offsetArgs` `skip`/`take` slice, so the sort is correct across page boundaries. `sortBy` is never accepted as a raw column name: the module's `*.validation.ts` declares a `.valid(...)` allowlist (Joi rejects anything else with 400), and `sortMap` maps each allowed key to its Prisma fragment. A key with no `sortMap` entry falls back to `fallback`.

Adopter: `GET /admin/members` — `sortBy` one of `name`, `email`, `role`, `createdAt`, `isActive` (`MEMBER_SORT_MAP` in `admin-members.service.ts`), fallback `{ createdAt: 'desc' }`.

### Keyset (cursor) — unused

```typescript
paginationSchema  // Joi: { cursor?: string, limit: number (1-100, default 20) }

buildPage(rows, limit)
// rows = query with take: limit + 1
// → { items: rows.slice(0, limit), nextCursor: lastItem.id | null }
```

Fetch `limit + 1` rows; `buildPage` trims to `limit` and derives `nextCursor` from the last kept row's `id` (null when no more). No route uses it today.

### Dropdown "options" helpers — unused

```typescript
optionsQuerySchema        // Joi: { q?: string (trim, '' allowed), page?: int>=1, pageSize?: int 1-100 } — NO defaults
optionalPaging({page,pageSize}) // → { page, pageSize } if EITHER was sent (page=1, pageSize=DEFAULT_OPTIONS_PAGE_SIZE=25 fill the other), else null
excludeIdsSchema          // Joi: comma-separated or repeated ids → string[] (trimmed, blanks dropped, max 500)
optionsResult(res, items, total, paging) // paging null → ok(res, items) (bare array); else paginated(res, items, pageMeta(total, paging))
```

For a searchable dropdown that pages only when the caller asks: a call with neither `page` nor `pageSize` gets a bare array, sending either gets the standard paged shape. No endpoint uses these yet; they are covered by `pagination.options.test.ts` and `response.test.ts`.

## Error handler

`src/core/middleware/errorHandler.ts`

All error responses share one envelope: `{ success: false, error: { code, message, details? } }`.

| Scenario | Response |
|---|---|
| `AppError` | `statusCode` + `{ success: false, error: { code, message, details } }` |
| Validation (`validate()`) | 400 + `error.code = 'VALIDATION_ERROR'`, `details = [{ field, message }]` (sent by the middleware itself, see `validation.md`) |
| Rate limit (`express-rate-limit`) | 429 + `error.code = 'TOO_MANY_REQUESTS'` (sent by the limiter's `message`, see `security.md`) |
| Prisma P2002 | 409 + `error.code = 'CONFLICT'`, message `<target> already exists` |
| Body rejected by `express.json()` (http-errors with `type`, 4xx `status`, `expose`) | `entity.parse.failed` → 400 `INVALID_JSON`; `entity.too.large` → 413 `PAYLOAD_TOO_LARGE` (limit 2mb); any other exposed 4xx → that status + `BAD_REQUEST`. Covered by `errorHandler.test.ts` against a real `express.json()` |
| Unknown route (`notFoundHandler`) | 404 + `error.code = 'NOT_FOUND'`, message `Route not found` |
| Unknown | 500 + `error.code = 'INTERNAL_ERROR'` (logged; no stack or message leaked) |

Prisma error code handling only for P2002 — other codes propagate as 500.

---
*Last updated: 2026-11-15 (rewritten against the NobleBid code: offset paging is the only strategy in use, `paginated()` `extra` argument, `ServiceUnavailable`, module error codes, `notFoundHandler`; keyset and options helpers marked unused)*
