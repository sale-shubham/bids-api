import { PrismaClient } from '../../generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { logger } from '@/core/logger/logger';

type ExtendedPrismaClient = PrismaClient;

/** The client inside `prisma.$transaction(async (tx) => …)`. */
export type TransactionClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

const globalForPrisma = globalThis as unknown as { prisma?: ExtendedPrismaClient };

if (!globalForPrisma.prisma) {
  const connectionUrl = process.env.DATABASE_URL || '';

  // Supabase pooler TLS: strip sslmode from URL, pass explicit ssl object to pg.
  const needsSsl =
    /sslmode=/i.test(connectionUrl) || /supabase\.(co|com)/i.test(connectionUrl);
  let poolUrl = connectionUrl;
  if (needsSsl) {
    try {
      const u = new URL(connectionUrl);
      u.searchParams.delete('sslmode');
      u.searchParams.delete('ssl');
      poolUrl = u.toString();
    } catch {
      // unparseable URL — use as-is
    }
  }

  const adapter = new PrismaPg({
    connectionString: poolUrl,
    max: 5,
    connectionTimeoutMillis: 30_000,
    ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  globalForPrisma.prisma = new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'production' ? [] : ['warn', 'error', 'query'],
  });

  globalForPrisma.prisma.$connect().catch((err) =>
    logger.warn({ err }, 'Prisma pre-warm connect failed (will retry on first query)'),
  );
}

export const prisma = globalForPrisma.prisma!;
