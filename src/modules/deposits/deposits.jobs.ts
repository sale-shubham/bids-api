import { prisma } from '@/core/prisma/client';
import { logger } from '@/core/logger/logger';
import { toPaise } from '@/core/money';
import { enqueueNotification } from '@/modules/notify/notify.queue';
import { issueDepositForfeitInvoice } from '@/modules/invoices/invoices.service';
import { releaseDecision } from './deposits.rules';

const BATCH = 100;

export type DepositReleaseCounts = { refunded: number; forfeited: number };

/**
 * Hourly (inside the sales maintenance job): settle HELD deposits whose auction is over.
 * Refund losers / paid winners / cancelled auctions / legacy winners; forfeit a winner whose sale was cancelled
 * for non-payment. Idempotent (guarded updates), batch-limited. A refund that fails at the gateway leaves the
 * deposit HELD (logged) and is retried on the next run.
 */
export async function runDepositRelease(now = new Date()): Promise<DepositReleaseCounts> {
  const counts: DepositReleaseCounts = { refunded: 0, forfeited: 0 };
  const held = await prisma.auctionDeposit.findMany({
    where: { status: 'HELD', auction: { OR: [{ status: { in: ['ENDED', 'CANCELLED'] } }, { deletedAt: { not: null } }] } },
    select: {
      id: true,
      auctionId: true,
      memberId: true,
      amountPaise: true,
      gatewayPaymentId: true,
      auction: { select: { status: true, deletedAt: true, winnerId: true } },
    },
    orderBy: { updatedAt: 'asc' },
    take: BATCH,
  });

  for (const d of held) {
    try {
      let saleStatus: string | null = null;
      if (d.auction.status === 'ENDED' && d.auction.winnerId === d.memberId) {
        const sale = await prisma.sale.findFirst({
          where: { auctionId: d.auctionId, buyerId: d.memberId },
          orderBy: { createdAt: 'desc' },
          select: { status: true },
        });
        saleStatus = sale?.status ?? null;
      }
      const decision = releaseDecision({
        auctionStatus: d.auction.status,
        auctionDeleted: d.auction.deletedAt !== null,
        winnerId: d.auction.winnerId,
        memberId: d.memberId,
        saleStatus,
      });
      if (decision === 'WAIT') continue;

      const amountPaise = toPaise(d.amountPaise);
      if (decision === 'FORFEIT') {
        const { count } = await prisma.auctionDeposit.updateMany({
          where: { id: d.id, status: 'HELD' },
          data: { status: 'FORFEITED', forfeitedAt: now },
        });
        if (count === 0) continue;
        counts.forfeited++;
        await issueDepositForfeitInvoice(d.id, now);
        await enqueueNotification({
          type: 'deposit-forfeited',
          memberId: d.memberId,
          auctionId: d.auctionId,
          data: { amountPaise },
          dedupeKey: `deposit-forfeited:${d.id}`,
        });
        continue;
      }

      if (!d.gatewayPaymentId) {
        logger.error({ depositId: d.id }, 'deposits job: held deposit has no gateway payment id, cannot refund');
        continue;
      }
      const { paymentProvider } = await import('@/providers/payment');
      const refund = await paymentProvider.refundPayment(d.gatewayPaymentId, { amountPaise, reverseAll: false });
      const { count } = await prisma.auctionDeposit.updateMany({
        where: { id: d.id, status: 'HELD' },
        data: { status: 'REFUNDED', refundId: refund.id, refundedAt: now },
      });
      if (count === 0) continue;
      counts.refunded++;
      await enqueueNotification({
        type: 'deposit-refunded',
        memberId: d.memberId,
        auctionId: d.auctionId,
        data: { amountPaise },
        dedupeKey: `deposit-refunded:${d.id}`,
      });
    } catch (err) {
      logger.error({ err, depositId: d.id }, 'deposits job: release failed, deposit stays HELD');
    }
  }
  return counts;
}
