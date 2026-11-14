// Prisma CLI configuration (Prisma 7+).
// Used ONLY by the prisma CLI (generate / migrate / db push / seed).
// Runtime connection lives in src/core/prisma/client.ts via @prisma/adapter-pg.
// Prisma 7 no longer auto-loads .env — dotenv must be imported explicitly.
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    // Migrations/seed use DIRECT connection (:5432) — not the pooler (:6543).
    url: env('DIRECT_URL'),
  },
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
});
