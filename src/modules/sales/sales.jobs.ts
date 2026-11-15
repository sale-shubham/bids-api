import { prisma } from '@/core/prisma/client';
import { logger } from '@/core/logger/logger';
import { notifySale, releaseSale } from './sales.service';
import { AUTO_CONFIRM_DAYS, DAY_MS } from './sales.rules';
import { applyStrikePolicy, createUnpaidStrike } from '@/modules/strikes/strikes.service';
import { runDepositRelease } from '@/modules/deposits/deposits.jobs';
import { expireOffers } from '@/modules/second-chance/second-chance.service';

const BATCH = 100;

export type SalesMaintenanceCounts = {
  cancelled: number;
  autoConfirmed: number;
  releaseRetried: number;
  depositsRefunded: number;
  depositsForfeited: number;
  offersExpired: number;
};

const facts = {
  id: true,
  auctionId: true,
  buyerId: true,
  sellerId: true,
  amountPaise: true,
  commissionPaise: true,
} as const;

/**
 * Hourly: (1) cancel unpaid sales past payBy (and strike the buyer), (2) auto-confirm SHIPPED sales 7 days after
 * shipping and release, (3) retry the release of DELIVERED sales, (4) refund / forfeit held bid deposits,
 * (5) expire second-chance offers. Idempotent (guarded updates), batch-limited;
 * a failure on one sale is logged and skipped.
 */
export async function runSalesMaintenance(now = new Date()): Promise<SalesMaintenanceCounts> {
  const counts: SalesMaintenanceCounts = {
    cancelled: 0,
    autoConfirmed: 0,
    releaseRetried: 0,
    depositsRefunded: 0,
    depositsForfeited: 0,
    offersExpired: 0,
  };

  const unpaid = await prisma.sale.findMany({
    where: { status: 'AWAITING_PAYMENT', payBy: { lt: now } },
    select: facts,
    orderBy: { payBy: 'asc' },
    take: BATCH,
  });
  for (const s of unpaid) {
    try {
      // Cancel + strike in one transaction: no cancelled sale without its strike.
      const struck = await prisma.$transaction(async (tx) => {
        const { count } = await tx.sale.updateMany({
          where: { id: s.id, status: 'AWAITING_PAYMENT' },
          data: { status: 'CANCELLED', cancelledAt: now },
        });
        if (count === 0) return null;
        return createUnpaidStrike(tx, { id: s.id, buyerId: s.buyerId }, now);
      });
      if (!struck) continue;
      counts.cancelled++;
      await notifySale('sale-cancelled', s.buyerId, s, 'BUYER', {}, true);
      await notifySale('sale-cancelled', s.sellerId, s, 'SELLER', {}, true);
      await applyStrikePolicy({
        strikeId: struck.strike.id,
        memberId: s.buyerId,
        auctionId: s.auctionId,
        activeCount: struck.activeCount,
        expiresAt: struck.strike.expiresAt,
      });
    } catch (err) {
      logger.error({ err, saleId: s.id }, 'sales job: cancel failed');
    }
  }

  const shipped = await prisma.sale.findMany({
    where: { status: 'SHIPPED', shippedAt: { lt: new Date(now.getTime() - AUTO_CONFIRM_DAYS * DAY_MS) } },
    select: { id: true },
    orderBy: { shippedAt: 'asc' },
    take: BATCH,
  });
  for (const s of shipped) {
    try {
      const { count } = await prisma.sale.updateMany({
        where: { id: s.id, status: 'SHIPPED' },
        data: { status: 'DELIVERED', deliveredAt: now },
      });
      if (count === 0) continue;
      counts.autoConfirmed++;
      await releaseSale(s.id, { from: ['DELIVERED'] }, now);
    } catch (err) {
      logger.error({ err, saleId: s.id }, 'sales job: auto-confirm failed');
    }
  }

  const pending = await prisma.sale.findMany({
    where: { status: 'DELIVERED', releasedAt: null },
    select: { id: true },
    orderBy: { deliveredAt: 'asc' },
    take: BATCH,
  });
  for (const s of pending) {
    try {
      const res = await releaseSale(s.id, { from: ['DELIVERED'] }, now);
      if (res.released) counts.releaseRetried++;
    } catch (err) {
      logger.error({ err, saleId: s.id }, 'sales job: release retry failed');
    }
  }

  const deposits = await runDepositRelease(now);
  counts.depositsRefunded = deposits.refunded;
  counts.depositsForfeited = deposits.forfeited;
  counts.offersExpired = await expireOffers(now);
  return counts;
}
