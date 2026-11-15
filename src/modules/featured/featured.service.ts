import { prisma } from '@/core/prisma/client';
import { AppError } from '@/core/errors/AppError';
import { toPaise } from '@/core/money';
import { logger } from '@/core/logger/logger';
import { bestEffort } from '@/core/best-effort';
import { getSetting } from '@/modules/settings/settings.service';
import { effectiveStatus } from '@/modules/auctions/auctions.serializer';
import { enqueueNotification } from '@/modules/notify/notify.queue';
import { ORDER_REUSE_MS } from '@/modules/commissions/commissions.service';
import { debitCredits } from '@/modules/credits/credits.service';
import { issueFeatureInvoice } from '@/modules/invoices/invoices.service';
import { FEATURED_ENABLED_KEY, FEATURED_PRICES_KEY, applyFeatureDays, parseFeaturedEnabled, parseFeaturePrices, type FeatureDays } from './featured.rules';

const REF_TYPE = 'FEATURE';

const auctionNotFound = () => new AppError(404, 'AUCTION_NOT_FOUND', 'Auction not found');

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** Extends featuredUntil inside the caller's transaction; returns the new value. */
async function applyToAuction(tx: Tx, auctionId: string, days: number, now: Date): Promise<Date> {
  const a = await tx.auction.findUnique({ where: { id: auctionId }, select: { featuredUntil: true, endTime: true } });
  if (!a) throw auctionNotFound();
  const next = applyFeatureDays(now, a.featuredUntil, days, a.endTime);
  await tx.auction.update({ where: { id: auctionId }, data: { featuredUntil: next } });
  return next;
}

async function afterPaid(purchase: { id: string; sellerId: string; auctionId: string; days: number }, featuredUntil: Date, now: Date) {
  await bestEffort(
    'feature: notify',
    () =>
      enqueueNotification({
        type: 'feature-activated',
        memberId: purchase.sellerId,
        auctionId: purchase.auctionId,
        data: { days: purchase.days, featuredUntil: featuredUntil.toISOString() },
        dedupeKey: `feature-activated:${purchase.id}`,
      }),
    { purchaseId: purchase.id },
  );
  await issueFeatureInvoice(purchase.id, now);
}

/** POST /auctions/:id/feature/checkout */
export async function checkout(memberId: string, auctionId: string, input: { days: FeatureDays; useCredits?: boolean }, now = new Date()) {
  const auction = await prisma.auction.findUnique({
    where: { id: auctionId },
    select: { id: true, title: true, status: true, deletedAt: true, startTime: true, endTime: true, sellerId: true },
  });
  if (!auction || auction.deletedAt || auction.sellerId !== memberId) throw auctionNotFound();
  const eff = effectiveStatus(auction, now);
  if (eff === 'ENDED' || eff === 'CANCELLED') throw new AppError(409, 'AUCTION_ENDED', 'This auction has ended');

  const [enabledRaw, pricesRaw] = await Promise.all([getSetting(FEATURED_ENABLED_KEY), getSetting(FEATURED_PRICES_KEY)]);
  if (!parseFeaturedEnabled(enabledRaw)) throw new AppError(409, 'FEATURE_DISABLED', 'Featured listings are not available right now');
  const amountPaise = parseFeaturePrices(pricesRaw)[String(input.days) as '1' | '3' | '7'];

  if (input.useCredits) {
    const result = await prisma.$transaction(async (tx) => {
      const purchase = await tx.featurePurchase.create({
        data: { auctionId, sellerId: memberId, days: input.days, amountPaise: BigInt(amountPaise), status: 'PAID', paidWith: 'CREDITS', paidAt: now },
        select: { id: true, sellerId: true, auctionId: true, days: true },
      });
      await debitCredits(tx, { memberId, amountPaise, reason: 'FEATURE_PURCHASE', refType: 'FEATURE_PURCHASE', refId: purchase.id });
      const featuredUntil = await applyToAuction(tx, auctionId, input.days, now);
      return { purchase, featuredUntil };
    });
    await afterPaid(result.purchase, result.featuredUntil, now);
    return { paidWithCredits: true as const, featuredUntil: result.featuredUntil };
  }

  const member = await prisma.member.findUnique({ where: { id: memberId }, select: { name: true, email: true, phone: true } });
  if (!member) throw new AppError(401, 'UNAUTHORIZED', 'Unauthorized');
  const { paymentProvider } = await import('@/providers/payment');
  const description = `Featured listing (${input.days} day${input.days > 1 ? 's' : ''}) for "${auction.title}"`.slice(0, 255);
  const respond = (orderId: string, keyId: string) => ({
    orderId,
    amountPaise,
    currency: 'INR' as const,
    keyId,
    description,
    prefill: { name: member.name, email: member.email, contact: member.phone ?? '' },
  });

  const recent = await prisma.featurePurchase.findMany({
    where: { auctionId, sellerId: memberId, days: input.days, amountPaise: BigInt(amountPaise), status: 'PENDING', createdAt: { gte: new Date(now.getTime() - ORDER_REUSE_MS) } },
    select: { id: true },
  });
  if (recent.length) {
    const existing = await prisma.paymentOrder.findFirst({
      where: { memberId, referenceType: REF_TYPE, referenceId: { in: recent.map((r) => r.id) }, status: 'CREATED', amountPaise: BigInt(amountPaise) },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) return respond(existing.gatewayOrderId, paymentProvider.publicKey);
  }

  const purchase = await prisma.featurePurchase.create({
    data: { auctionId, sellerId: memberId, days: input.days, amountPaise: BigInt(amountPaise), status: 'PENDING' },
    select: { id: true },
  });
  // Razorpay receipt max 40 chars: "f_" + 12 chars of the id + "_" + base36 time (<= 9).
  const receipt = `f_${purchase.id.slice(-12)}_${now.getTime().toString(36)}`;
  const created = await paymentProvider.createOrder({ amountPaise, receipt, notes: { featureId: purchase.id, auctionId, memberId } });
  await prisma.paymentOrder.create({
    data: {
      memberId,
      gatewayOrderId: created.gatewayOrderId,
      amountPaise: BigInt(amountPaise),
      referenceType: REF_TYPE,
      referenceId: purchase.id,
      idempotencyKey: `feature:${purchase.id}:${created.gatewayOrderId}`,
    },
  });
  return respond(created.gatewayOrderId, created.keyId);
}

const NOTHING = { applied: false, purchaseId: null as string | null };

/**
 * Settle the featured purchase an order pays for. ONE transaction, idempotent: the purchase only moves when it is
 * still PENDING (guarded update), so verify + webhook (or redeliveries) extend the listing exactly once.
 */
export async function markFeaturePaid(
  input: { paymentOrderId: string; gatewayPaymentId?: string | null },
  now = new Date(),
): Promise<{ applied: boolean; purchaseId: string | null }> {
  const result = await prisma.$transaction(async (tx) => {
    const order = await tx.paymentOrder.findUnique({ where: { id: input.paymentOrderId } });
    if (!order || order.referenceType !== REF_TYPE || !order.referenceId) return { ...NOTHING, purchase: null, featuredUntil: null as Date | null };
    const purchase = await tx.featurePurchase.findUnique({ where: { id: order.referenceId }, select: { id: true, sellerId: true, auctionId: true, days: true } });
    if (!purchase) return { ...NOTHING, purchase: null, featuredUntil: null as Date | null };

    const moved = await tx.featurePurchase.updateMany({
      where: { id: purchase.id, status: 'PENDING' },
      data: { status: 'PAID', paidWith: 'RAZORPAY', paidAt: now, paymentOrderId: order.id },
    });
    // The gateway took the money either way, so the order is always marked PAID.
    await tx.paymentOrder.updateMany({ where: { id: order.id, status: { not: 'PAID' } }, data: { status: 'PAID', gatewayPaymentId: input.gatewayPaymentId ?? null } });
    const applied = moved.count === 1;
    let featuredUntil: Date | null = null;
    if (applied) featuredUntil = await applyToAuction(tx, purchase.auctionId, purchase.days, now);
    else logger.info({ purchaseId: purchase.id, orderId: order.id }, 'feature purchase already settled, effect skipped');
    return { applied, purchaseId: purchase.id as string | null, purchase, featuredUntil };
  });

  if (result.applied && result.purchase && result.featuredUntil) await afterPaid(result.purchase, result.featuredUntil, now);
  return { applied: result.applied, purchaseId: result.purchaseId };
}

export async function getFeaturePurchaseDTO(purchaseId: string) {
  const p = await prisma.featurePurchase.findUnique({
    where: { id: purchaseId },
    select: { id: true, auctionId: true, days: true, amountPaise: true, status: true, paidWith: true, paidAt: true, createdAt: true, auction: { select: { featuredUntil: true } } },
  });
  if (!p) return null;
  return { id: p.id, auctionId: p.auctionId, days: p.days, amountPaise: toPaise(p.amountPaise), status: p.status, paidWith: p.paidWith, paidAt: p.paidAt, featuredUntil: p.auction.featuredUntil };
}

/** GET /auctions/:id/feature (owner). */
export async function getFeature(memberId: string, auctionId: string) {
  const auction = await prisma.auction.findUnique({ where: { id: auctionId }, select: { id: true, sellerId: true, featuredUntil: true, deletedAt: true } });
  if (!auction || auction.deletedAt || auction.sellerId !== memberId) throw auctionNotFound();
  const rows = await prisma.featurePurchase.findMany({
    where: { auctionId, sellerId: memberId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { id: true, days: true, amountPaise: true, status: true, paidWith: true, paidAt: true, createdAt: true },
  });
  return {
    featuredUntil: auction.featuredUntil,
    purchases: rows.map((r) => ({ id: r.id, days: r.days, amountPaise: toPaise(r.amountPaise), status: r.status, paidWith: r.paidWith, paidAt: r.paidAt, createdAt: r.createdAt })),
  };
}
