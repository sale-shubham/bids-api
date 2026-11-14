import type { IncrementResponse, Options, Store } from 'express-rate-limit';
import { prisma } from '@/core/prisma/client';

// express-rate-limit store backed by the RateLimitBucket table, so a limit is
// shared by every Lambda container instead of counted per container (the
// in-memory default). Fixed window: the first hit after `resetAt` starts a
// new window at 1. One atomic upsert per hit — no read-modify-write race
// between concurrent requests. Used only on the money/security-bearing
// limiters (rateLimit.ts); a DB error fails open via `passOnStoreError`.
export class PgRateLimitStore implements Store {
  prefix: string;
  localKeys = false;
  private windowMs = 60_000;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  init(options: Options) {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<IncrementResponse> {
    const rows = await prisma.$queryRaw<{ hits: number; resetAt: Date }[]>`
      INSERT INTO "RateLimitBucket" ("key", "hits", "resetAt")
      VALUES (${this.prefix + key}, 1, now() + ${this.windowMs} * interval '1 millisecond')
      ON CONFLICT ("key") DO UPDATE SET
        "hits"    = CASE WHEN "RateLimitBucket"."resetAt" <= now() THEN 1 ELSE "RateLimitBucket"."hits" + 1 END,
        "resetAt" = CASE WHEN "RateLimitBucket"."resetAt" <= now()
                         THEN now() + ${this.windowMs} * interval '1 millisecond'
                         ELSE "RateLimitBucket"."resetAt" END
      RETURNING "hits", "resetAt"`;
    return { totalHits: Number(rows[0].hits), resetTime: rows[0].resetAt };
  }

  async decrement(key: string) {
    await prisma.$executeRaw`
      UPDATE "RateLimitBucket" SET "hits" = GREATEST("hits" - 1, 0)
      WHERE "key" = ${this.prefix + key}`;
  }

  async resetKey(key: string) {
    await prisma.rateLimitBucket.deleteMany({ where: { key: this.prefix + key } });
  }
}
