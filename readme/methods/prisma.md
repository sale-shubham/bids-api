# Prisma

## Client singleton

`src/core/prisma/client.ts`

```typescript
import { PrismaClient } from '../../generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';

/** The client inside `prisma.$transaction(async (tx) => …)`. */
export type TransactionClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

// Cached on globalThis so a warm Lambda container reuses one client (+ its pool).
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

if (!globalForPrisma.prisma) {
  // Supabase pooler TLS: strip sslmode from the URL, pass an explicit ssl object.
  const adapter = new PrismaPg({
    connectionString: poolUrl,        // DATABASE_URL, sslmode/ssl params stripped
    max: 5,                           // small pool — the pooler does the real pooling
    connectionTimeoutMillis: 30_000,
    ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  globalForPrisma.prisma = new PrismaClient({ adapter, log: /* [] in prod, warn/error/query otherwise */ });
  globalForPrisma.prisma.$connect().catch(/* warn, retry on first query */);
}

export const prisma = globalForPrisma.prisma!;
```

- Import the singleton from `src/core/prisma/client.ts` — never `new PrismaClient()` elsewhere in `src/`. Reused across warm Lambda invocations via `globalThis`. (The seed scripts in `prisma/` build their own client, see below.)
- `@prisma/adapter-pg` — pure-JS node-postgres driver, no Rust/OpenSSL native bindings.
- TLS: `needsSsl` is true when the URL carries `sslmode=` or points at a Supabase host; the `sslmode` / `ssl` query params are then removed and `ssl: { rejectUnauthorized: false }` is passed to `pg` instead.
- Generated client at `src/generated/prisma/` (Prisma 7 `prisma-client` generator, ESM). It is imported as `@prisma/client` everywhere via a tsconfig `paths` alias (`@prisma/client` → `src/generated/prisma/client.ts`); the same alias is mirrored in `vitest.config.ts` (exact-match regex) so tests resolve the generated client, not the partial npm package. The generated folder is gitignored; CI runs `npx prisma generate`.
- Connection is pre-warmed (`$connect()`) to cut first-query latency on cold start.
- Type a helper's `tx` parameter as `TransactionClient` (exported from `client.ts`) when it must run inside a caller's interactive transaction.

## Version

Prisma 7. Generated client entry point: `src/generated/prisma/client.ts` (not `index.js`).

## Connection

| Env var | Purpose |
|---|---|
| `DATABASE_URL` | Connection **pooler** URL (`:6543`, `pgbouncer=true&connection_limit=1`) — used at runtime by the adapter in `src/core/prisma/client.ts`. Required at boot (`env.ts`) |
| `DIRECT_URL` | Direct DB URL (`:5432`) — used by the Prisma CLI (`migrate` / `seed`) and the seed scripts. Not set on the Lambda |

Prisma 7 splits these: the schema datasource only declares the provider, and the
CLI connection lives in `prisma.config.ts` (which imports `dotenv/config` itself, since Prisma 7 no longer auto-loads `.env`):
```prisma
// prisma/schema.prisma
datasource db {
  provider = "postgresql"
}
```
```typescript
// prisma.config.ts — used ONLY by the CLI (generate / migrate / seed)
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: env('DIRECT_URL') },   // direct connection for migrations
  migrations: { path: 'prisma/migrations', seed: 'tsx prisma/seed.ts' },
});
```

## Models

Current models live in `prisma/schema.prisma`: `Member` (role `BIDDER` / `AUCTIONEER` / `SUPER_ADMIN`), `Session`, `OtpChallenge`, `Auction`, `Bid` (`kind` `BidKind` `MANUAL` / `AUTO` / `BUY_NOW`), `MaxBid` (composite id `auctionId` + `bidderId`, `maxAmountPaise`; a bidder's private proxy maximum, cascade on auction delete, never exposed to other members), `Watchlist` (composite id `memberId` + `auctionId`), `Commission` (one per auction), `Notification` (unique `dedupeKey`), `WsConnection`, `WsTicket`, `PushSubscription`, `RateLimitBucket`, `PaymentOrder` (unique `idempotencyKey` and `gatewayOrderId`), `WebhookEvent` (unique `gatewayEventId`), `AppSetting` (key/value, `value` is text parsed in code), `Review` (one per auction, unique `auctionId`), `AuctionQuestion` (cascade on auction delete), `SavedSearch` (cascade on member delete; `minPricePaise` / `maxPricePaise` are `BigInt?`). `Member.ratingCount` / `ratingSum` are `Int` counters of non-hidden reviews (`reviews.md`). Every money column is a `BigInt` in paise (`startingBidPaise`, `minIncrementPaise`, `currentBidPaise`, `reservePricePaise?`, `buyNowPricePaise?`, `maxAmountPaise`, `amountPaise`, `unpaidCommissionPaise`, `moneySpentPaise`; see "Money (BigInt paise)" below); commission rates are basis points (`rateBps`, 500 = 5%).

Auth is session-backed: there is no refresh-token table, but every JWT carries the id of a `Session` row (see `security.md`). Migrations live in `prisma/migrations/`; CI applies pending ones with `npx prisma migrate deploy` (`.github/workflows/deploy_serverless.yml`).

## Money (BigInt paise)

- Money columns are Postgres `BIGINT`; Prisma returns `bigint` for them (`_sum` / `_max` aggregates too). Application code, pure rules (`bidding.rules.ts`), DTOs, JSON responses, WebSocket payloads, SQS / notification `data`, email template data and payment-provider amounts all use `number`.
- Convert at the boundary where a row or aggregate enters number-typed code with `toPaise(v)` / `toPaiseOrNull(v)` from `src/core/money.ts` (throws a plain `Error` when the value is not a safe integer). Done in the auction serializers (`toCard`, `toDetail`), `toBidDTO`, auction detail, bids, auction close, commissions, payments, leaderboard, member selects (`withMemberMoney`), and the admin dashboard / members / payments.
- Writes keep passing `number` (BigInt inputs accept `bigint | number`, including `{ increment }`). Raw SQL binds the amount as `BigInt`.
- `HARD_MAX_PRICE_PAISE` (1,000,000,000,000) lives in `src/core/money.ts`; the admin ceiling `auction.maxPricePaise` is read by `getMaxPricePaise()` (`src/modules/settings/max-price.ts`).
- Safety net: `src/core/json-bigint.ts` defines `BigInt.prototype.toJSON` (number when safe, else decimal string); imported first in `src/app.ts` and `index.js`. Explicit conversion stays the rule.

## Concurrency patterns

- **Bids** (`bids.service.ts` `placeBid`): one interactive `$transaction` (`maxWait` 5 s, `timeout` 10 s) that first runs `SELECT id FROM "Auction" WHERE id = … FOR UPDATE`, then reads the auction with `findUniqueOrThrow` and the leader's `MaxBid`, validates, resolves the max bid, upserts the bidder's `MaxBid`, inserts the resulting `Bid` rows and updates the auction. Two concurrent bids on one auction serialise on the row lock. **Buy It Now** (`bids.service.ts` `buyNow`) uses the same lock and closes the auction in the same transaction via `closeOneTx`. Events and notifications fire after commit.
- **Closing** (`auction-close.service.ts`, `closeOneTx`): each auction closes in its own `$transaction` (or inside the Buy It Now transaction) that starts with a guarded `updateMany` (`status` open, `endTime <= now`); a count of 0 means another run (or an anti-sniping extension) got there first, and the close is a no-op.
- **Counters**: the unpaid-commission total is lowered with raw SQL `GREATEST(0, "unpaidCommissionPaise" - …)` so it never goes negative; `PgRateLimitStore` uses one atomic `INSERT … ON CONFLICT DO UPDATE` per hit.
- **Reviews**: `createReview` inserts the `Review` and bumps the seller's `ratingCount` / `ratingSum` in one `$transaction`; a unique violation on `auctionId` maps to 409 `ALREADY_REVIEWED`. The admin hide / unhide flips `hiddenAt` with a guarded `updateMany` and adjusts the totals only when a row changed. Replies and answers use `updateMany` with `sellerReply: null` / `answer: null` in the WHERE.
- **Idempotency** relies on unique columns: `Notification.dedupeKey`, `WebhookEvent.gatewayEventId`, `PaymentOrder.idempotencyKey`, `Watchlist` upsert on its composite id.

## Seed

`prisma/seed.ts` — run with `npm run prisma:seed` (`tsx prisma/seed.ts`). Uses `DIRECT_URL`, falling back to `DATABASE_URL`, with the same SSL-stripping as the runtime client.
Imports from `'../src/generated/prisma/client.js'` (tsx resolves `.js` to `.ts`).

It is **idempotent** and never overwrites admin-edited data:

1. **App settings** — upserts with `update: {}` (created only when missing): `commission.rateBps` = `500`, `auction.minIncrementPaise` = `10000`, `auction.antiSnipingMinutes` = `2`, `auction.maxPricePaise` = `10000000000`, `auction.categories` = a JSON array of starter categories.
2. **Legal pages** — for each entry of `LEGAL_SEED` in `prisma/legal-seed-content.ts` (`terms-conditions`, `privacy-policy`, `refund-policy`), creates `page:<slug>` (HTML) and `page-title:<slug>` in `AppSetting` only when missing. The copy is draft text kept in git for review; the admin edits it afterwards at `/admin/settings`. See `readme/flows/legal-pages.md`.
3. **Super Admin** — created only when both `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` are set (password hashed with bcrypt cost 12, email marked verified). An existing member with that email is left unchanged. Remove `SEED_ADMIN_PASSWORD` from the environment after the first seed.

`prisma/seed-demo.ts` — run manually with `npm run seed:demo`. Creates one demo AUCTIONEER (`demo.seller@noblebid.local`) and about 12 auctions spread over live, upcoming and ended, in the configured categories. Idempotent: if the demo seller already exists it does nothing.

**⚠️ `npm run prisma:migrate:reset` runs `prisma migrate reset --force`** — it drops the database, re-applies every migration and then runs `prisma/seed.ts`. Never run it against a database whose data you want to keep.

Log in as the seeded Super Admin with `POST /auth/login` (email + password). New signups verify their email with an OTP; with `EMAIL_DRIVER=stub` the code is always `OTP_STUB_CODE` (default `123456`) and is logged server-side.

## Error codes

| Code | Meaning | HTTP |
|---|---|---|
| P2002 | Unique constraint violation | 409 `CONFLICT` via `errorHandler.ts`, unless the service catches it first |
| P2025 | Record not found (`findUniqueOrThrow`, `update` / `delete` on a missing row) | Not mapped — 500. Services look up with `findUnique` and throw an `AppError` 404 (`NotFound`, `AUCTION_NOT_FOUND`, …) instead |

`errorHandler.ts` handles P2002 → 409 automatically. Two services catch P2002 themselves because a duplicate there is expected: `notify.service.ts` (a concurrent insert of the same `Notification.dedupeKey` counts as `'duplicate'`) and `payments.service.ts` (a concurrent `WebhookEvent` insert for an already-recorded delivery). `findUniqueOrThrow` is only used inside transactions right after the row was locked or updated, where a miss cannot happen.

---
*Last updated: 2026-11-15 (rewritten against the NobleBid schema and seed scripts: model list, concurrency patterns, idempotent `seed.ts` + `seed-demo.ts`, email + password login, P2002 / P2025 handling)*
