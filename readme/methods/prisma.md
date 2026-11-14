# Prisma

## Client singleton

`src/core/prisma/client.ts`

```typescript
import { PrismaClient } from '../../generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';

// Cached on globalThis so a warm Lambda container reuses one client (+ its pool).
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

if (!globalForPrisma.prisma) {
  // Supabase pooler TLS: strip sslmode from the URL, pass an explicit ssl object.
  const adapter = new PrismaPg({
    connectionString: poolUrl,        // DATABASE_URL, sslmode stripped
    max: 5,                           // small pool — the pooler does the real pooling
    connectionTimeoutMillis: 30_000,
    ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  globalForPrisma.prisma = new PrismaClient({ adapter, log: /* [] in prod */ });
  globalForPrisma.prisma.$connect().catch(/* warn, retry on first query */);
}

export const prisma = globalForPrisma.prisma!;
```

- Import the singleton from `src/core/prisma/client.ts` — never `new PrismaClient()` elsewhere. Reused across warm Lambda invocations via `globalThis`.
- `@prisma/adapter-pg` — pure-JS node-postgres driver, no Rust/OpenSSL native bindings.
- Generated client at `src/generated/prisma/` (Prisma 7 output). It is imported as `@prisma/client` everywhere via a tsconfig `paths` alias (`@prisma/client` → `generated/prisma/client.ts`); the same alias is mirrored in `vitest.config.ts` (exact-match regex) so tests resolve the generated client, not the partial npm package.
- Connection is pre-warmed (`$connect()`) to cut first-query latency on cold start.
- The singleton is `new PrismaClient(…).$extends(testDataExtension)` — every read passes the test-data filter that hides Playwright test rows from real accounts (see [test-data.md](./test-data.md)). Because the client is extended, type a `$transaction(async (tx) => …)` parameter as `TransactionClient` exported from `client.ts`, never `Prisma.TransactionClient` (the pre-extension type, which no longer accepts the `tx` handed out).

## Version

Prisma 7. Generated client entry point: `src/generated/prisma/client.ts` (not `index.js`).

## Connection

| Env var | Purpose |
|---|---|
| `DATABASE_URL` | Connection **pooler** URL — used at runtime by the adapter in `src/core/prisma/client.ts` |
| `DIRECT_URL` | Direct DB URL (:5432) — used by the Prisma CLI (`migrate` / `seed`) |

Prisma 7 splits these: the schema datasource only declares the provider, and the
CLI connection lives in `prisma.config.ts`:
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

Current models live in `prisma/schema.prisma`. Notable recent additions: `Upload`
(tracks ownership of `/uploads` objects) and `Listing.searchText` (denormalized
full-text haystack backed by a GIN `to_tsvector` index, added in the
`20260626120000_review_hardening` migration). Auth is **stateless** — there is no
`RefreshToken` model. CI applies pending migrations with `prisma migrate deploy`.

## Seed

`prisma/seed.ts` — run with `npx tsx prisma/seed.ts`.
Imports from `'../src/generated/prisma/client.js'` (tsx resolves `.js` to `.ts`).

**Data source: `prisma/current-data.json`** — a direct dump of every row in the
live current-schema DB (Member, Business, BusinessMember, Product,
Specification, SpecificationOption, ProductSpecification, Listing,
ListingSpecValue, Feature, Plan, PlanFeature, Subscription, AppSetting),
replayed 1:1 into a fresh database in FK-dependency order. This is the "new
legacy data" going forward — regenerate it the same read-only way whenever the
live data should become the new seed baseline (see the temp dump script
pattern in git history for `_dump_current.ts`, deleted after use — not a
committed script, re-author it ad hoc from the model list here + the app's own
SSL-stripping pattern in `src/core/prisma/client.ts` when needed again).

**⚠️ `main()` starts by `deleteMany()`-ing every table it seeds — never run
`npx tsx prisma/seed.ts` against a database with real/live data you want to
keep.** It's for a fresh/dev database only. `prisma:migrate:reset` runs
`prisma migrate reset --force` (drops the DB, re-applies migrations, then
auto-runs this seed) — same caveat applies.

Log in as any seeded/dumped member via `/auth/otp/request` + `/auth/otp/verify`
with the stub code (`OTP_STUB_CODE` env var, default `123456`, active while
`OTP_DRIVER=stub`) — no separate hardcoded test-account bypass exists anymore.

**Legal pages** (`prisma/legal-pages.seed.ts`) are seeded separately from the
dump — `DEFAULT_LEGAL_PAGES` holds starter Privacy Policy / Terms & Conditions
HTML, written into `AppSetting` as `page:<slug>` right after the dumped
`AppSetting` rows. It's a code constant, not part of `current-data.json`, so the
copy is reviewable in git; the admin edits it afterwards at `/admin/settings`.
The block **upserts** (unlike the dump replay, which creates), so re-running the
seed overwrites admin-authored copy back to the defaults. See
`readme/flows/legal-pages.md`.

`prisma/seed-real-members.ts` is a separate one-off operational script (not
run by `prisma:migrate:reset`) — see its own header comment.

## Error codes

| Code | Meaning | HTTP |
|---|---|---|
| P2002 | Unique constraint violation | 409 Conflict |
| P2025 | Record not found | Forwarded as-is; services throw AppError(404) |

`errorHandler.ts` handles P2002 → 409 automatically.

---
*Last updated: 2026-10-28 (client extended with `testDataExtension`; new `TransactionClient` type for `tx` parameters — see `test-data.md`)*

*Previously: 2026-07-27 (`seed.ts` rewritten around `prisma/current-data.json` — a fresh dump of the live current-schema DB — replacing the old `legacy-data.json` (deleted) which mapped pre-restructure Member/SubMember data onto the new Member+Business split; the mapping layer is gone since the dump is already in current shape, straight 1:1 replay now. The stale "two users, admin@p2x.com" description this section had was already outdated before this change — email+password auth doesn't exist in this app (mobile+OTP only, see `readme/flows/auth.md`) — and has been rewritten to match what `seed.ts` actually does.)*
