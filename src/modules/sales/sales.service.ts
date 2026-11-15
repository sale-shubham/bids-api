import { prisma } from '@/core/prisma/client';
import { AppError } from '@/core/errors/AppError';
import { toPaise } from '@/core/money';
import { logger } from '@/core/logger/logger';
import { offsetArgs, pageMeta } from '@/core/http/pagination';
import { enqueueNotification } from '@/modules/notify/notify.queue';
import { ORDER_REUSE_MS } from '@/modules/commissions/commissions.service';
import { issueCommissionInvoice } from '@/modules/invoices/invoices.service';
import { qualifyReferralBestEffort } from '@/modules/referrals/referrals.service';
import { toShippingDTO } from '@/modules/auctions/listing.rules';
import { toOfferDTO, type OfferStatusValue } from '@/modules/second-chance/second-chance.rules';
import {
  ADMIN_RELEASABLE,
  CONFIRMABLE,
  DISPUTABLE,
  REFUNDABLE,
  payoutPaise,
  resolveDelivery,
  type DeliveryChoice,
  type SaleStatus,
} from './sales.rules';

const REF_TYPE = 'SALE';

const person = { select: { id: true, name: true, email: true, phone: true } } as const;
export const saleInclude = {
  auction: { select: { id: true, title: true, images: true, shippingOptions: true } },
  buyer: person,
  seller: person,
  secondChanceOffer: {
    select: { id: true, auctionId: true, amountPaise: true, status: true, expiresAt: true, respondedAt: true, newSaleId: true, createdAt: true },
  },
} as const;

type Person = { id: string; name: string; email: string; phone: string | null };
export type SaleRow = {
  id: string;
  auctionId: string;
  buyerId: string;
  sellerId: string;
  status: SaleStatus;
  itemPaise: bigint | number;
  shippingFeePaise: bigint | number;
  deliveryChoice?: string | null;
  amountPaise: bigint | number;
  commissionPaise: bigint | number;
  payBy: Date;
  paidAt: Date | null;
  shippingMethod: string | null;
  courier: string | null;
  trackingNo: string | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  releasedAt: Date | null;
  disputedAt: Date | null;
  disputeReason: string | null;
  refundedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  auction: { id: string; title: string; images: string[]; shippingOptions?: unknown };
  buyer: Person;
  seller: Person;
  secondChanceOffer?: {
    id: string;
    auctionId: string;
    amountPaise: bigint | number;
    status: OfferStatusValue;
    expiresAt: Date;
    respondedAt: Date | null;
    newSaleId: string | null;
    createdAt: Date;
  } | null;
};

export type SaleViewer = { id: string; role?: string };
export type SaleRole = 'BUYER' | 'SELLER' | 'ADMIN';

export const saleNotFound = () => new AppError(404, 'SALE_NOT_FOUND', 'Sale not found');
export const invalidState = (msg = 'This action is not allowed in the sale\'s current state') =>
  new AppError(409, 'SALE_INVALID_STATE', msg);

export function viewerRole(s: { buyerId: string; sellerId: string }, viewer: SaleViewer): SaleRole | null {
  if (viewer.id === s.buyerId) return 'BUYER';
  if (viewer.id === s.sellerId) return 'SELLER';
  return viewer.role === 'SUPER_ADMIN' ? 'ADMIN' : null;
}

const contact = (p: Person) => ({ name: p.name, email: p.email, phone: p.phone });

export function toSaleDTO(s: SaleRow, role: SaleRole, now = new Date()) {
  const amountPaise = toPaise(s.amountPaise);
  const commissionPaise = toPaise(s.commissionPaise);
  const paid = s.paidAt !== null;
  return {
    id: s.id,
    auctionId: s.auctionId,
    auction: { id: s.auction.id, title: s.auction.title, coverImage: s.auction.images[0] ?? null },
    status: s.status,
    itemPaise: toPaise(s.itemPaise),
    shippingFeePaise: toPaise(s.shippingFeePaise),
    deliveryChoice: s.deliveryChoice === 'COURIER' || s.deliveryChoice === 'PICKUP' ? s.deliveryChoice : null,
    shippingOptions: toShippingDTO(s.auction.shippingOptions),
    amountPaise,
    payBy: s.payBy,
    paidAt: s.paidAt,
    shippingMethod: s.shippingMethod,
    courier: s.courier,
    trackingNo: s.trackingNo,
    shippedAt: s.shippedAt,
    deliveredAt: s.deliveredAt,
    releasedAt: s.releasedAt,
    disputedAt: s.disputedAt,
    disputeReason: s.disputeReason,
    refundedAt: s.refundedAt,
    cancelledAt: s.cancelledAt,
    createdAt: s.createdAt,
    role,
    buyer: { id: s.buyer.id, name: s.buyer.name },
    seller: { id: s.seller.id, name: s.seller.name },
    ...(role !== 'BUYER' ? { commissionPaise, payoutPaise: payoutPaise(amountPaise, commissionPaise) } : {}),
    ...(role === 'SELLER'
      ? {
          secondChanceOffer: s.secondChanceOffer ? toOfferDTO(s.secondChanceOffer, s.auction, now) : null,
          canOfferSecondChance: s.status === 'CANCELLED' && !s.secondChanceOffer,
        }
      : {}),
    ...(role === 'SELLER' && paid ? { buyerContact: contact(s.buyer) } : {}),
    ...(role === 'BUYER' && paid ? { sellerContact: contact(s.seller) } : {}),
  };
}
export type SaleDTO = ReturnType<typeof toSaleDTO>;

// ---------------------------------------------------------------- reads

/** One sale, only for its buyer, its seller or a SUPER_ADMIN (404 otherwise, so ids do not leak). */
export async function getSaleDTO(id: string, viewer: SaleViewer): Promise<SaleDTO> {
  const row = (await prisma.sale.findUnique({ where: { id }, include: saleInclude })) as SaleRow | null;
  if (!row) throw saleNotFound();
  const role = viewerRole(row, viewer);
  if (!role) throw saleNotFound();
  return toSaleDTO(row, role);
}

export async function listMine(
  memberId: string,
  q: { role: 'buyer' | 'seller'; status?: SaleStatus; page: number; pageSize: number },
) {
  const where = { ...(q.role === 'seller' ? { sellerId: memberId } : { buyerId: memberId }), ...(q.status ? { status: q.status } : {}) };
  const [rows, total] = await Promise.all([
    prisma.sale.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], include: saleInclude, ...offsetArgs(q) }),
    prisma.sale.count({ where }),
  ]);
  const role: SaleRole = q.role === 'seller' ? 'SELLER' : 'BUYER';
  return { items: (rows as SaleRow[]).map((r) => toSaleDTO(r, role)), meta: pageMeta(total, q) };
}

// ---------------------------------------------------------------- notifications

type SaleFacts = { id: string; auctionId: string; buyerId: string; sellerId: string; amountPaise: bigint | number; commissionPaise: bigint | number };

async function notifySale(
  type: 'sale-receipt' | 'sale-paid' | 'sale-shipped' | 'sale-released' | 'sale-disputed' | 'sale-refunded' | 'sale-cancelled',
  memberId: string,
  s: SaleFacts,
  role: SaleRole,
  extra: Record<string, unknown> = {},
  multi = false,
) {
  const amountPaise = toPaise(s.amountPaise);
  await enqueueNotification({
    type,
    memberId,
    auctionId: s.auctionId,
    data: { saleId: s.id, role, amountPaise, payoutPaise: payoutPaise(amountPaise, toPaise(s.commissionPaise)), ...extra },
    dedupeKey: multi ? `${type}:${s.id}:${memberId}` : `${type}:${s.id}`,
  });
}
export { notifySale };

// ---------------------------------------------------------------- checkout

/**
 * Create (or reuse) a Razorpay order for one AWAITING_PAYMENT sale, with the seller's share
 * attached as an ON-HOLD Route transfer (amount - platform commission). Same payload as commissions.
 */
export async function checkout(memberId: string, saleId: string, now = new Date(), delivery?: DeliveryChoice) {
  const sale = await prisma.sale.findFirst({
    where: { id: saleId, buyerId: memberId },
    select: {
      id: true,
      status: true,
      payBy: true,
      sellerId: true,
      itemPaise: true,
      shippingFeePaise: true,
      deliveryChoice: true,
      amountPaise: true,
      commissionPaise: true,
      auction: { select: { title: true, shippingOptions: true } },
    },
  });
  if (!sale) throw saleNotFound();
  if (sale.status !== 'AWAITING_PAYMENT' || sale.payBy.getTime() <= now.getTime()) {
    throw new AppError(409, 'SALE_NOT_PAYABLE', 'This sale can no longer be paid');
  }
  const payout = await prisma.sellerPayoutAccount.findUnique({
    where: { sellerId: sale.sellerId },
    select: { status: true, razorpayAccountId: true },
  });
  if (!payout || payout.status !== 'ACTIVE') {
    throw new AppError(409, 'PAYOUT_ACCOUNT_INACTIVE', 'The seller cannot receive payments right now');
  }
  const member = await prisma.member.findUnique({ where: { id: memberId }, select: { name: true, email: true, phone: true } });
  if (!member) throw new AppError(401, 'UNAUTHORIZED', 'Unauthorized');

  // Delivery choice fixes the shipping fee; the order amount follows (commission stays on the item price, the seller gets amount - commission).
  const decision = resolveDelivery(toShippingDTO(sale.auction.shippingOptions), delivery);
  if (decision.kind === 'required') {
    throw new AppError(400, 'DELIVERY_CHOICE_REQUIRED', 'Choose COURIER or PICKUP for this order', [{ field: 'delivery', message: 'delivery is required' }]);
  }
  let saleAmount: bigint | number = sale.amountPaise;
  if (decision.kind === 'chosen') {
    const newAmount = toPaise(sale.itemPaise) + decision.shippingFeePaise;
    if (decision.choice !== sale.deliveryChoice || decision.shippingFeePaise !== toPaise(sale.shippingFeePaise) || newAmount !== toPaise(sale.amountPaise)) {
      const { count } = await prisma.sale.updateMany({
        where: { id: sale.id, status: 'AWAITING_PAYMENT' },
        data: { deliveryChoice: decision.choice, shippingFeePaise: decision.shippingFeePaise, amountPaise: newAmount },
      });
      if (count === 0) throw new AppError(409, 'SALE_NOT_PAYABLE', 'This sale can no longer be paid');
    }
    saleAmount = newAmount;
  }

  const { paymentProvider } = await import('@/providers/payment');
  const amountPaise = toPaise(saleAmount);
  const description = `Payment for "${sale.auction.title}"`.slice(0, 255);
  const respond = (orderId: string, keyId: string) => ({
    orderId,
    amountPaise,
    currency: 'INR' as const,
    keyId,
    description,
    prefill: { name: member.name, email: member.email, contact: member.phone ?? '' },
  });

  const existing = await prisma.paymentOrder.findFirst({
    where: {
      memberId,
      referenceType: REF_TYPE,
      referenceId: sale.id,
      status: 'CREATED',
      amountPaise: saleAmount,
      createdAt: { gte: new Date(now.getTime() - ORDER_REUSE_MS) },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) return respond(existing.gatewayOrderId, paymentProvider.publicKey);

  // Razorpay receipt max 40 chars: "s_" + 12 chars of the id + "_" + base36 time (<= 9).
  const receipt = `s_${sale.id.slice(-12)}_${now.getTime().toString(36)}`;
  const created = await paymentProvider.createOrder({
    amountPaise,
    receipt,
    notes: { saleId: sale.id, memberId },
    transfers: [
      {
        account: payout.razorpayAccountId,
        amountPaise: payoutPaise(amountPaise, toPaise(sale.commissionPaise)),
        onHold: true,
        notes: { saleId: sale.id },
      },
    ],
  });
  await prisma.paymentOrder.create({
    data: {
      memberId,
      gatewayOrderId: created.gatewayOrderId,
      amountPaise: saleAmount,
      referenceType: REF_TYPE,
      referenceId: sale.id,
      idempotencyKey: `sale:${sale.id}:${created.gatewayOrderId}`,
    },
  });
  return respond(created.gatewayOrderId, created.keyId);
}

// ---------------------------------------------------------------- settlement

const NOTHING = { applied: false, saleId: null as string | null };

/**
 * Settle the sale an order pays for. ONE transaction, idempotent: the Sale only moves when it is still
 * AWAITING_PAYMENT (guarded update), so verify + webhook (or redeliveries) produce exactly one effect.
 * A PAID Commission row is written so admin commission reports stay right.
 */
export async function markSalePaid(
  input: { paymentOrderId: string; gatewayPaymentId?: string | null },
  now = new Date(),
): Promise<{ applied: boolean; saleId: string | null }> {
  const result = await prisma.$transaction(async (tx) => {
    const order = await tx.paymentOrder.findUnique({ where: { id: input.paymentOrderId } });
    if (!order || order.referenceType !== REF_TYPE || !order.referenceId) return { ...NOTHING, sale: null, commissionId: null as string | null };
    const sale = await tx.sale.findUnique({
      where: { id: order.referenceId },
      select: { id: true, auctionId: true, buyerId: true, sellerId: true, amountPaise: true, commissionPaise: true, rateBps: true },
    });
    if (!sale) return { ...NOTHING, sale: null, commissionId: null as string | null };

    const moved = await tx.sale.updateMany({
      where: { id: sale.id, status: 'AWAITING_PAYMENT' },
      data: { status: 'PAID', paidAt: now, gatewayPaymentId: input.gatewayPaymentId ?? null },
    });
    // The gateway took the money either way, so the order is always marked PAID.
    await tx.paymentOrder.updateMany({
      where: { id: order.id, status: { not: 'PAID' } },
      data: { status: 'PAID', gatewayPaymentId: input.gatewayPaymentId ?? null },
    });
    const applied = moved.count === 1;
    let commissionId: string | null = null;
    if (applied) {
      const created = await tx.commission.create({
        data: {
          auctionId: sale.auctionId,
          sellerId: sale.sellerId,
          rateBps: sale.rateBps,
          amountPaise: sale.commissionPaise,
          status: 'PAID',
          dueAt: now,
          paidAt: now,
          paymentOrderId: order.id,
        },
        select: { id: true },
      });
      commissionId = created?.id ?? null;
    } else {
      logger.info({ saleId: sale.id, orderId: order.id }, 'sale already settled (or not payable), payment effect skipped');
    }
    return { applied, saleId: sale.id as string | null, sale, commissionId };
  });

  if (result.applied && result.sale) {
    const { sale } = result;
    await storeTransferId(sale.id, input.gatewayPaymentId ?? null);
    await notifySale('sale-paid', sale.sellerId, sale, 'SELLER');
    await notifySale('sale-receipt', sale.buyerId, sale, 'BUYER');
    if (result.commissionId) await issueCommissionInvoice(result.commissionId, now);
  }
  return { applied: result.applied, saleId: result.saleId };
}

/** Pick the seller's transfer from the payment's transfers (the only one, or the one for the account). */
async function findTransferId(gatewayPaymentId: string, sellerId: string): Promise<string | null> {
  const { paymentProvider } = await import('@/providers/payment');
  const transfers = await paymentProvider.fetchPaymentTransfers(gatewayPaymentId);
  if (transfers.length === 0) return null;
  const acct = await prisma.sellerPayoutAccount.findUnique({ where: { sellerId }, select: { razorpayAccountId: true } });
  const match = transfers.find((t) => acct && t.account === acct.razorpayAccountId) ?? transfers[0];
  return match.id;
}

/** Best-effort: store the Route transfer id on the sale (never throws). */
export async function storeTransferId(saleId: string, gatewayPaymentId: string | null): Promise<void> {
  if (!gatewayPaymentId) return;
  try {
    const sale = await prisma.sale.findUnique({ where: { id: saleId }, select: { sellerId: true, transferId: true } });
    if (!sale || sale.transferId) return;
    const id = await findTransferId(gatewayPaymentId, sale.sellerId);
    if (id) await prisma.sale.updateMany({ where: { id: saleId, transferId: null }, data: { transferId: id } });
  } catch (err) {
    logger.warn({ err, saleId }, 'sale: could not fetch the transfer id (will be fetched on release)');
  }
}

// ---------------------------------------------------------------- state machine

async function loadParty(id: string, memberId: string, party: 'buyer' | 'seller') {
  const sale = await prisma.sale.findFirst({
    where: { id, ...(party === 'buyer' ? { buyerId: memberId } : { sellerId: memberId }) },
    select: {
      id: true,
      auctionId: true,
      buyerId: true,
      sellerId: true,
      status: true,
      amountPaise: true,
      commissionPaise: true,
      courier: true,
      trackingNo: true,
    },
  });
  if (!sale) throw saleNotFound();
  return sale;
}

export async function shipSale(
  memberId: string,
  id: string,
  input: { method: 'COURIER' | 'PICKUP'; courier?: string; trackingNo?: string },
  now = new Date(),
): Promise<SaleDTO> {
  const sale = await loadParty(id, memberId, 'seller');
  if (sale.status !== 'PAID') throw invalidState('Only a paid sale can be marked as shipped');
  const { count } = await prisma.sale.updateMany({
    where: { id, status: 'PAID' },
    data: {
      status: 'SHIPPED',
      shippedAt: now,
      shippingMethod: input.method,
      courier: input.courier ?? null,
      trackingNo: input.trackingNo ?? null,
    },
  });
  if (count === 0) throw invalidState();
  await notifySale('sale-shipped', sale.buyerId, sale, 'BUYER', { courier: input.courier ?? '', trackingNo: input.trackingNo ?? '' });
  return getSaleDTO(id, { id: memberId });
}

export type ReleaseResult = { released: boolean; error?: unknown };

/**
 * Release the held transfer to the seller and mark the sale RELEASED. Only from a status in `from`;
 * a gateway failure leaves the sale as it was (DELIVERED is retried by the maintenance job).
 * Never throws.
 */
export async function releaseSale(
  saleId: string,
  opts: { from: readonly SaleStatus[]; resolution?: string },
  now = new Date(),
): Promise<ReleaseResult> {
  try {
    const sale = await prisma.sale.findUnique({
      where: { id: saleId },
      select: { id: true, auctionId: true, buyerId: true, sellerId: true, status: true, transferId: true, gatewayPaymentId: true, amountPaise: true, commissionPaise: true },
    });
    if (!sale || !opts.from.includes(sale.status)) return { released: false };

    let transferId = sale.transferId;
    if (!transferId) {
      if (!sale.gatewayPaymentId) throw new Error('sale has no gateway payment id');
      transferId = await findTransferId(sale.gatewayPaymentId, sale.sellerId);
      if (!transferId) throw new Error('no Route transfer found for the payment');
      await prisma.sale.updateMany({ where: { id: saleId, transferId: null }, data: { transferId } });
    }
    const { paymentProvider } = await import('@/providers/payment');
    await paymentProvider.releaseTransfer(transferId);

    const wasDisputed = sale.status === 'DISPUTED';
    const { count } = await prisma.sale.updateMany({
      where: { id: saleId, status: { in: [...opts.from] } },
      data: {
        status: 'RELEASED',
        releasedAt: now,
        ...(wasDisputed ? { resolvedAt: now, resolution: opts.resolution ?? 'RELEASED' } : {}),
      },
    });
    if (count === 1) {
      await notifySale('sale-released', sale.sellerId, sale, 'SELLER');
      await qualifyReferralBestEffort([sale.buyerId, sale.sellerId], now);
    }
    return { released: count === 1 };
  } catch (err) {
    logger.error({ err, saleId }, 'sale: release failed, will be retried');
    return { released: false, error: err };
  }
}

/** Buyer confirms delivery (PAID | SHIPPED -> DELIVERED), then the payout is released (RELEASED). */
export async function confirmSale(memberId: string, id: string, now = new Date()): Promise<SaleDTO> {
  const sale = await loadParty(id, memberId, 'buyer');
  if (!CONFIRMABLE.includes(sale.status)) throw invalidState('This sale cannot be confirmed right now');
  const { count } = await prisma.sale.updateMany({
    where: { id, status: { in: [...CONFIRMABLE] } },
    data: { status: 'DELIVERED', deliveredAt: now },
  });
  if (count === 0) throw invalidState();
  await releaseSale(id, { from: ['DELIVERED'] }, now); // a failure leaves DELIVERED; the job retries
  return getSaleDTO(id, { id: memberId });
}

export async function disputeSale(memberId: string, id: string, reason: string, now = new Date()): Promise<SaleDTO> {
  const sale = await loadParty(id, memberId, 'buyer');
  if (!DISPUTABLE.includes(sale.status)) throw invalidState('This sale cannot be disputed right now');
  const { count } = await prisma.sale.updateMany({
    where: { id, status: { in: [...DISPUTABLE] } },
    data: { status: 'DISPUTED', disputedAt: now, disputeReason: reason },
  });
  if (count === 0) throw invalidState();
  await notifySale('sale-disputed', sale.sellerId, sale, 'SELLER', { reason });
  const admins = await prisma.member.findMany({ where: { role: 'SUPER_ADMIN', isActive: true }, select: { id: true } });
  for (const a of admins) await notifySale('sale-disputed', a.id, sale, 'ADMIN', { reason }, true);
  return getSaleDTO(id, { id: memberId });
}
