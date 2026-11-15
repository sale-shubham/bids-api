# Categories flow

Code: `src/modules/categories/categories.{routes,service,rules,validation}.ts` (public reads + shared logic), `src/modules/admin/categories/admin-categories.routes.ts` (admin CRUD). Decision D13: the `Category` table replaces the AppSetting `auction.categories` list; `Auction.category` stays as the denormalised category **name**.

## Schema

`Category { id cuid, slug @unique, name, parentId? (self relation "CategoryTree", onDelete Restrict), sortOrder Int @default(0), isActive @default(true), description?, attributeSchema Json @default("[]"), createdAt, updatedAt }`, index `(parentId)`.

`Auction.categoryId String?` (FK, index) and `Auction.category String` (the category name, always written together with `categoryId`; renaming a category updates it for that category's auctions in the same transaction). `Auction.attributes Json?` holds the seller's values for the category's `attributeSchema`; a GIN index `Auction_attributes_gin` (`jsonb_path_ops`) lives in the migration SQL only (`readme/methods/prisma.md`).

`attributeSchema` = array of `AttributeDef { key /^[a-z][a-z0-9_]{0,39}$/, label <= 60, type 'text'|'number'|'select', options? (select only, 1..50 strings), required?, unit? <= 12 }`, at most 30 defs, unique keys.

## Endpoints

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/categories` | public | `{ items: CategoryNode[] }`, the active tree. `CategoryNode = { id, slug, name, description, parentId, sortOrder, attributeSchema, liveCount, children }`; `liveCount` = live auctions in the category and all its descendants; siblings ordered by `sortOrder`, then name; a node under an inactive parent is hidden. `Cache-Control: public, max-age=60` |
| GET | `/categories/:slug/stats` | public | `{ liveCount, soldCount90d, medianSoldPaise: number\|null }` over the category and its descendants. Sold = stored ENDED with a winner and `endedAt` in the last 90 days; the median of `currentBidPaise` comes from a raw `percentile_cont(0.5)` query (numeric converted to a number). 404 `CATEGORY_NOT_FOUND`. Same cache header |
| GET | `/auctions/categories` | public | legacy shape `{ categories: [{ name, liveCount }] }`, now the active root categories |
| GET | `/admin/categories` | SUPER_ADMIN | `{ items }` flat, inactive included, each `{ id, slug, name, description, parentId, sortOrder, isActive, attributeSchema, auctionCount, createdAt, updatedAt }` |
| POST | `/admin/categories` | SUPER_ADMIN | `{ name <= 60, slug?, parentId?, sortOrder?, isActive?, description? <= 500, attributeSchema? }` -> 201 `{ category }`. Without `slug` it is generated from the name (lower-case, non-alphanumerics to `-`, numeric suffix when taken); an explicit slug that exists -> 409 `CATEGORY_SLUG_TAKEN`; unknown parent -> 400 `INVALID_PARENT` |
| PATCH | `/admin/categories/:id` | SUPER_ADMIN | same fields, at least one; `parentId: null` makes it a root. Moving under itself or a descendant -> 400 `CATEGORY_CYCLE`; slug clash -> 409 `CATEGORY_SLUG_TAKEN`; renaming rewrites `Auction.category` |
| DELETE | `/admin/categories/:id` | SUPER_ADMIN | 409 `CATEGORY_IN_USE` (`details { auctionCount, childCount }`) when it has auctions or children, else deleted -> `{ id }` |

`GET /auctions/:id/similar-sold` is documented in `auctions.md`.

## Attribute validation

`validateAttributes(schema, input)` (`categories.rules.ts`, pure): for each schema def, `required` keys must be present and non-empty; `number` accepts finite numbers and numeric strings (stored as numbers); `select` must be one of `options`; `text` is trimmed, at most 200 chars; keys not in the schema are dropped. Failure -> `{ ok: false, fields: [{ field: 'attributes.<key>', message }] }`; the auction service turns it into 400 `INVALID_ATTRIBUTES` with `details.fields`. An empty result is stored as `null`. `buildSpecs(schema, attributes)` builds the detail `specs` in schema order (keys no longer in the schema are omitted).

## How auctions use it

- Create / patch accept `categoryId` (preferred) or the legacy `category` (name or slug, case-insensitive). It must resolve to an **active** category, else 400 `INVALID_CATEGORY`. Both columns are written together. `categoryId` wins when both are sent.
- Browse `category=<slug|name>` matches that category plus all descendants (`resolveBrowseCategoryIds` -> `categoryId IN (...)`); a term that matches no category falls back to the legacy name column.
- Saved searches match descendants (`saved-searches.md`).
- Detail carries `categoryId`, `categoryPath` (root to leaf) and `specs` (`categoryContext`, walking `parentId`).

## Platform settings

`categories` in `GET /settings/public` and `GET /admin/settings` is derived: names of the active root categories, sorted alphabetically. In `PUT /admin/settings` it is optional and ignored (a debug line is logged). The old AppSetting row `auction.categories` is left in the table but never read.

## Seed and migration

`npm run prisma:seed` creates the ten starter categories only when the `Category` table is empty. Migration `20261115230000_listing_quality` converted the AppSetting list (array order = `sortOrder`) plus every distinct existing `Auction.category` value into root categories and backfilled `Auction.categoryId` by name (details in `readme/methods/prisma.md`).

## Tests

`categories/categories.test.ts` (validateAttributes matrix, specs, slugify, tree + liveCount, admin create / patch / delete rules, stats median, resolution helpers), `__tests__/http/listing.http.test.ts` (routes), guards and validation matrices.
