import { prisma } from '@/core/prisma/client';
import { AppError } from '@/core/errors/AppError';
import { toPaise } from '@/core/money';
import { logger } from '@/core/logger/logger';
import { offsetArgs, pageMeta } from '@/core/http/pagination';
import {
  getSaleDTO,
  invalidState,
  notifySale,
  releaseSale,
  saleInclude,
  saleNotFound,
  toSaleDTO,
  type SaleRow,
} from '@/modules/sales/sales.service';
import { ADMIN_RELEASABLE, REFUNDABLE, type SaleStatus } from '@/modules/sales/sales.rules';

const admin = (adminId: string) => ({ id: adminId, role: 'SUPER_ADMIN' });

export async function listSales(q: { status?: SaleStatus; q?: string; page: number; pageSize: number }) {
  const term = q.q?.trim();
  const where = {
    ...(q.status ? { status: q.status } : {}),
    ...(term
      ? {
          OR: [
            { id: term },
            { auction: { title: { contains: term, mode: 'insensitive' as const } } },
            { buyer: { OR: [{ name: { contains: term, mode: 'insensitive' as const } }, { email: { contains: term, mode: 'insensitive' as const } }] } },
            { seller: { OR: [{ name: { contains: term, mode: 'insensitive' as const } }, { email: { contains: term, mode: 'insensitive' as const } }] } },
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.sale.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], include: saleInclude, ...offsetArgs(q) }),
    prisma.sale.count({ where }),
  ]);
  const items = (rows as SaleRow[]).map((r) => ({
    ...toSaleDTO(r, 'ADMIN'),
    buyer: { id: r.buyer.id, name: r.buyer.name, email: r.buyer.email },
    seller: { id: r.seller.id, name: r.seller.name, email: r.seller.email },
  }));
  return { items, meta: pageMeta(total, q) };
}

/** Admin: release held funds to the seller (DISPUTED | DELIVERED -> RELEASED). */
export async function adminRelease(saleId: string, adminId: string) {
  const sale = await prisma.sale.findUnique({ where: { id: saleId }, select: { status: true } });
  if (!sale) throw saleNotFound();
  if (!ADMIN_RELEASABLE.includes(sale.status)) throw invalidState('Only a disputed or delivered sale can be released');
  const res = await releaseSale(saleId, { from: ADMIN_RELEASABLE, resolution: 'RELEASED_BY_ADMIN' });
  if (!res.released) {
    if (res.error) throw new AppError(502, 'RELEASE_FAILED', 'The payment gateway could not release the funds, try again');
    throw invalidState();
  }
  logger.info({ saleId, adminId }, 'sale released by admin');
  return getSaleDTO(saleId, admin(adminId));
}

/** Admin: refund the buyer in full, reversing the held transfer (PAID | SHIPPED | DELIVERED | DISPUTED -> REFUNDED). */
export async function adminRefund(saleId: string, adminId: string, note?: string, now = new Date()) {
  const sale = await prisma.sale.findUnique({
    where: { id: saleId },
    select: { id: true, auctionId: true, buyerId: true, sellerId: true, status: true, amountPaise: true, commissionPaise: true, gatewayPaymentId: true },
  });
  if (!sale) throw saleNotFound();
  if (!REFUNDABLE.includes(sale.status)) throw invalidState('This sale cannot be refunded in its current state');
  if (!sale.gatewayPaymentId) throw new AppError(409, 'SALE_NO_PAYMENT', 'This sale has no payment to refund');

  const { paymentProvider } = await import('@/providers/payment');
  const refund = await paymentProvider.refundPayment(sale.gatewayPaymentId, { amountPaise: toPaise(sale.amountPaise), reverseAll: true });

  const wasDisputed = sale.status === 'DISPUTED';
  const moved = await prisma.$transaction(async (tx) => {
    const { count } = await tx.sale.updateMany({
      where: { id: saleId, status: { in: [...REFUNDABLE] } },
      data: {
        status: 'REFUNDED',
        refundedAt: now,
        ...(wasDisputed ? { resolvedAt: now } : {}),
        resolution: note ? `REFUNDED: ${note}` : 'REFUNDED',
      },
    });
    if (count === 1) {
      await tx.commission.updateMany({ where: { auctionId: sale.auctionId, status: 'PAID' }, data: { status: 'WAIVED' } });
    }
    return count === 1;
  });
  if (!moved) {
    logger.error({ saleId, refundId: refund.id }, 'sale refunded at the gateway but its state changed meanwhile, check manually');
    throw invalidState();
  }
  logger.info({ saleId, adminId, refundId: refund.id }, 'sale refunded by admin');
  await notifySale('sale-refunded', sale.buyerId, sale, 'BUYER', {}, true);
  await notifySale('sale-refunded', sale.sellerId, sale, 'SELLER', {}, true);
  return getSaleDTO(saleId, admin(adminId));
}
