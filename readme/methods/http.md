# HTTP Utilities

## Route params — `param(req, name)` (`src/core/http/params.ts`)

Read a named route param with `param(req, 'id')`, never `req.params.id`. Express 5's types widen every param to `string | string[]` (a wildcard like `/*splat` captures an array), so `req.params.x` no longer type-checks where a `string` is expected. `param()` returns the string and throws `BadRequest` (400) if the value is missing or an array — no route here uses a wildcard, so that only fires on a routing bug. Covered by `params.test.ts` against a real Express 5 router.

Express 5 route patterns (path-to-regexp v8): wildcards must be named (`/*splat`), optional segments use braces (`/items{/:id}`), and regex/`?`/`+` patterns are gone. `req.query` is a read-only getter — `validate()` replaces it with `Object.defineProperty`, never assignment.

## AppError

`src/core/errors/AppError.ts`

```typescript
class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) { ... }
}
```

Throw for expected, user-facing errors. `errorHandler` converts to JSON response. Factory helpers: `BadRequest` (400), `Unauthorized` (401), `Forbidden` (403), `NotFound` (404), `Conflict` (409), `UnprocessableEntity` (422), `TooManyRequests` (429).

## Response helpers

`src/core/http/response.ts`

```typescript
ok(res, data, statusCode = 200)
// → { success: true, data }

paginated(res, items, meta)
// → { success: true, data: items, meta: { nextCursor?: string | null, total?: number } }
```

Always use these — never `res.json()` directly in route handlers.

## asyncHandler

`src/core/middleware/asyncHandler.ts`

```typescript
asyncHandler(fn: AsyncRequestHandler): RequestHandler
```

Wraps async route handler. Forwards thrown errors to Express `next`. Use on every async handler.

## Pagination

`src/core/http/pagination.ts`

Two strategies live side by side. Keyset (cursor) is the default; offset (page-numbers + `q` search) is used by admin/member list tables that want jump-to-page.

### Keyset (cursor)

```typescript
paginationSchema  // Joi: { cursor?: string, limit: number (1-100, default 20) }

buildPage(rows, limit)
// rows = query with take: limit + 1
// → { items: rows.slice(0, limit), nextCursor: lastItem.id | null }
```

Fetch `limit + 1` rows, `buildPage` trims to `limit` and derives `nextCursor` from the last kept row's `id` (null when no more). Validate query with `paginationSchema` via `validate(paginationSchema, 'query')`. Used by the buyer catalog/FTS search. (Admin/member list tables — members, listings, member-edits — use **offset** below.)

### Offset (page-numbers)

```typescript
offsetSchema  // Joi: { page: int>=1 (default 1), pageSize: int 1-100 (default 20), q?: string }
offsetArgs({ page, pageSize })     // → { skip: (page-1)*pageSize, take: pageSize }
pageMeta(total, { page, pageSize }) // → { total, page, pageSize, totalPages }
```

Service runs `findMany({ where, ...offsetArgs(p) })` + `count({ where })` in a `Promise.all`, returns `{ items, total }`. Controller responds `paginated(res, items, pageMeta(total, { page, pageSize }))`. Free-text `q` filters via `{ <field>: { contains: q, mode: 'insensitive' } }`. Extend `offsetSchema.keys({ status: ... })` to add per-list filters. Adopters: `GET /listings/mine`, `GET /admin/listings`, `GET /admin/members` (uses `search` not `q`), `GET /admin/subscriptions`.

### Dropdown "options" endpoints — `q` + opt-in paging (2026-11-02)

Every endpoint behind a searchable dropdown in the web app (server-side `q`, 25 rows per page, load-more on scroll, "x of N") shares these helpers from `src/core/http/pagination.ts` / `response.ts`:

```typescript
optionsQuerySchema        // Joi: { q?: string (trim, '' allowed), page?: int>=1, pageSize?: int 1-100 } — NO defaults
optionalPaging({page,pageSize}) // → { page, pageSize } if EITHER was sent (page=1, pageSize=25 fill the other), else null
excludeIdsSchema          // Joi: comma-separated or repeated ids → string[] (trimmed, max 500)
optionsResult(res, items, total, paging) // paging null → ok(res, items) (legacy bare array); else paginated(res, items, pageMeta(total, paging))
```

**Opt-in rule:** a call with neither `page` nor `pageSize` returns exactly what it always did (bare array, or the endpoint's own legacy cap), so the deployed app keeps working. Sending either returns the standard paged shape `{ success, data: rows, meta: { total, page, pageSize, totalPages } }`, with no 200-row cap. Empty `q` is valid and means "no filter". Label lookups for a selected id that may be off the loaded page are per-endpoint `GET .../:id` routes (see the flow docs). Adopters: `GET /admin/businesses/members-options`, `/admin/listings/business-options`, `/admin/watchlist/members`, `/admin/inquiries/members`, `/admin/plans`, `/admin/features`, `/admin/specifications`, `/admin/quantities` (these two key off `page` only), `GET /products`. Covered by `pagination.options.test.ts`, `response.test.ts`, `modules/admin/options-endpoints.test.ts`.

### Column sort (`sortBy`/`sortOrder`)

```typescript
sortOrderSchema  // Joi: 'asc' | 'desc', optional — the shared half; sortBy itself is validated per-module

buildOrderBy(sortBy, sortOrder, sortMap, fallback)
// sortMap: Record<string, (order: SortOrder) => PrismaOrderByFragment>
// → sortMap[sortBy]?.(order) ?? fallback
```

Backs the web app's `SortableTableHead`/`useSortState` (`readme/ui/components.md` there) — a click sends `sortBy`/`sortOrder` as query params, this turns them into a real Prisma `orderBy` **before** the `offsetArgs` `skip`/`take` slice, so sort is correct across page boundaries (client-side re-sort alone can only ever reorder the one page already fetched). `sortBy` is never accepted as a raw column name: each module declares its own `.valid('name', 'createdAt', ...)` allowlist in its `*.validation.ts` (Joi rejects anything else with 400 before the handler runs), matching that page's actual `SortableTableHead` `sortKey`s. `sortMap` then maps each allowed key to the Prisma fragment — a direct column (`{ name: order }`), a to-one relation field (`{ member: { name: order } }`, for a frontend dot-path key like `'member.name'`), or a to-many relation's row count (`{ productSpecs: { _count: order } }`, Prisma's `_count` orderBy). A key computed in JS after the fetch (e.g. `admin-members.service.ts`'s `activeBusinessCount`/`activeWatchlistCount`/`activeSubscriptionCount`, counted per-status off an already-fetched relation — can't `_count` the same relation twice with different filters in one query) has no `sortMap` entry and silently falls back to `fallback` — the web app's client-side `useSortedItems` still reorders whatever page loads either way. Adopters: `GET /admin/members`, `GET /admin/listings`, `GET /admin/products`, `GET /admin/specifications`, `GET /admin/features`, `GET /admin/subscriptions`, `GET /admin/breach-incidents`, `GET /admin/watchlist/entries`.

## Error handler

`src/core/middleware/errorHandler.ts`

All error responses share one envelope: `{ success: false, error: { code, message, details? } }`.

| Scenario | Response |
|---|---|
| `AppError` | `statusCode` + `{ success: false, error: { code, message, details } }` |
| Validation (`validate()`) | 400 + `error.code = 'VALIDATION_ERROR'`, `details = [{ field, message }]` |
| Multer upload reject | 400 (bad type) / 413 (`LIMIT_FILE_SIZE`) — mapped to `AppError` in `uploads.routes.ts` |
| Prisma P2002 | 409 + `error.code = 'CONFLICT'` |
| Body rejected by `express.json()` (http-errors with `type`, 4xx `status`, `expose`) | `entity.parse.failed` → 400 `INVALID_JSON`; `entity.too.large` → 413 `PAYLOAD_TOO_LARGE` (limit 2mb); any other exposed 4xx → that status + `BAD_REQUEST`. Covered by `errorHandler.test.ts` against a real `express.json()` |
| Unknown | 500 + `error.code = 'INTERNAL_ERROR'` (no stack leaked) |

Prisma error code handling only for P2002 — other codes propagate as 500.

---
*Last updated: 2026-11-02 (dropdown options: `optionsQuerySchema`/`optionalPaging`/`excludeIdsSchema`/`optionsResult`)*
*Previously: 2026-10-20 (malformed / oversized JSON bodies now 400 / 413 instead of 500; Express 5: `param(req, name)` for route params, v5 route-pattern rules)*
*Previously: 2026-09-16 (added the `sortBy`/`sortOrder` column-sort convention — `sortOrderSchema` +
`buildOrderBy()` in `src/core/http/pagination.ts` — to all 8 admin offset-paginated list endpoints, so
the web app's admin table sort clicks now actually order the full dataset server-side before paginating,
not just the client-side re-sort of whichever page loaded)*
