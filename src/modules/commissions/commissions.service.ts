import { prisma } from '@/core/prisma/client';
import { AppError } from '@/core/errors/AppError';
import { logger } from '@/core/logger/logger';
import { offsetArgs, pageMeta } from '@/core/http/pagination';
import { enqueueNotification } from '@/modules/notify/notify.queue';

const REF_TYPE = 'COMMISSION';
export const ORDER_REUSE_MS = 30 * 60 * 1000;
export const REMINDER_AFTER_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export type CommissionStatusFilter = 'due' | 'paid' | 'waived' | 'all';

const commissionSelect = {
  id: true,
  auctionId: true,
  rateBps: true,
  amountPaise: true,
  status: true,
  dueAt: true,
  paidAt: true,
  createdAt: true,
  auction: { select: { id: true, title: true, images: true, currentBidPaise: true, endedAt: true } },
} as const;

type CommissionRow = {
  id: string;
  auctionId: string;
  rateBps: number;
  amountPaise: number;
  status: 'DUE' | 'PAID' | 'WAIVED';
  dueAt: Date;
  paidAt: Date | null;
  createdAt: Date;
  auction: { id: string; title: string; images: string[]; currentBidPaise: number; endedAt: Date | null };
};

export function toCommissionDTO(c: CommissionRow, now = new Date()) {
  return {
    id: c.id,
    auctionId: c.auctionId,
    auction: {
      id: c.auction.id,
      title: c.auction.title,
      coverImage: c.auction.images[0] ?? null,
      finalBidPaise: c.auction.currentBidPaise,
      endedAt: c.auction.endedAt,
    },
    rateBps: c.rateBps,
    amountPaise: c.amountPaise,
    status: c.status,
    dueAt: c.dueAt,
    paidAt: c.paidAt,
    createdAt: c.createdAt,
    isOverdue: c.status === 'DUE' && c.dueAt.getTime() < now.getTime(),
  };
}
export type CommissionDTO = ReturnType<typeof toCommissionDTO>;

const notFound = () => new AppError(404, 'COMMISSION_NOT_FOUND', 'Commission not found');
const notDue = () => new AppError(409, 'COMMISSION_NOT_DUE', 'This commission is not due');

export async function getCommissionDTO(id: string, now = new Date()): Promise<CommissionDTO> {
  const row = await prisma.commission.findUnique({ where: { id }, select: commissionSelect });
  if (!row) throw notFound();
  return toCommissionDTO(row as CommissionRow, now);
}

// ---------------------------------------------------------------- reads

/** One commission, only if it belongs to the seller (404 otherwise, so ids do not leak). */
export async function getMine(sellerId: string, id: string, now = new Date()): Promise<CommissionDTO> {
  const row = await prisma.commission.findFirst({ where: { id, sellerId }, select: commissionSelect });
  if (!row) throw notFound();
  return toCommissionDTO(row as CommissionRow, now);
}

export async function listMine(
  sellerId: string,
  q: { status: CommissionStatusFilter; page: number; pageSize: number },
  now = new Date(),
) {
  const where = {
    sellerId,
    ...(q.status === 'all' ? {} : { status: q.status.toUpperCase() as 'DUE' | 'PAID' | 'WAIVED' }),
  };
  // Due ones: soonest deadline first. Everything else: newest first.
  const orderBy = q.status === 'due' ? [{ dueAt: 'asc' as const }] : [{ createdAt: 'desc' as const }];
  const [rows, total] = await Promise.all([
    prisma.commission.findMany({ where, orderBy, select: commissionSelect, ...offsetArgs(q) }),
    prisma.commission.count({ where }),
  ]);
  return { items: rows.map((r) => toCommissionDTO(r as CommissionRow, now)), meta: pageMeta(total, q) };
}

export async function summary(sellerId: string, now = new Date()) {
  const due = { sellerId, status: 'DUE' as const };
  const [agg, overdueCount] = await Promise.all([
    prisma.commission.aggregate({ where: due, _sum: { amountPaise: true }, _count: { _all: true } }),
    prisma.commission.count({ where: { ...due, dueAt: { lt: now } } }),
  ]);
  return { unpaidPaise: agg._sum.amountPaise ?? 0, dueCount: agg._count._all, overdueCount };
}

/** Admin: all commissions, each with its seller. */
export async function listAll(q: { status: CommissionStatusFilter; page: number; pageSize: number }, now = new Date()) {
  const where = q.status === 'all' ? {} : { status: q.status.toUpperCase() as 'DUE' | 'PAID' | 'WAIVED' };
  const orderBy = q.status === 'due' ? [{ dueAt: 'asc' as const }] : [{ createdAt: 'desc' as const }];
  const [rows, total] = await Promise.all([
    prisma.commission.findMany({
      where,
      orderBy,
      select: { ...commissionSelect, seller: { select: { id: true, name: true, email: true } } },
      ...offsetArgs(q),
    }),
    prisma.commission.count({ where }),
  ]);
  const items = rows.map((r) => ({ ...toCommissionDTO(r as unknown as CommissionRow, now), seller: r.seller }));
  return { items, meta: pageMeta(total, q) };
}

// ---------------------------------------------------------------- checkout

/**
 * Create (or reuse) a Razorpay order for one DUE commission. A CREATED order for
 * the same commission + amount younger than 30 min is returned again so repeated
 * clicks do not spam the gateway.
 */
export async function checkout(memberId: string, commissionId: string, now = new Date()) {
  const commission = await prisma.commission.findFirst({
    where: { id: commissionId, sellerId: memberId },
    select: { id: true, status: true, amountPaise: true, auction: { select: { title: true } } },
  });
  if (!commission) throw notFound();
  if (commission.status !== 'DUE') throw notDue();

  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: { name: true, email: true, phone: true },
  });
  if (!member) throw new AppError(401, 'UNAUTHORIZED', 'Unauthorized');

  const { paymentProvider } = await import('@/providers/payment');
  const description = `Commission for "${commission.auction.title}"`.slice(0, 255);
  const respond = (orderId: string, keyId: string) => ({
    orderId,
    amountPaise: commission.amountPaise,
    currency: 'INR' as const,
    keyId,
    description,
    prefill: { name: member.name, email: member.email, contact: member.phone ?? '' },
  });

  const existing = await prisma.paymentOrder.findFirst({
    where: {
      memberId,
      referenceType: REF_TYPE,
      referenceId: commission.id,
      status: 'CREATED',
      amountPaise: commission.amountPaise,
      createdAt: { gte: new Date(now.getTime() - ORDER_REUSE_MS) },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) return respond(existing.gatewayOrderId, paymentProvider.publicKey);

  // Razorpay receipt max 40 chars: "c_" + 12 chars of the id + "_" + base36 time (<= 9).
  const receipt = `c_${commission.id.slice(-12)}_${now.getTime().toString(36)}`;
  const created = await paymentProvider.createOrder({
    amountPaise: commission.amountPaise,
    receipt,
    notes: { commissionId: commission.id, memberId },
  });
  await prisma.paymentOrder.create({
    data: {
      memberId,
      gatewayOrderId: created.gatewayOrderId,
      amountPaise: commission.amountPaise,
      referenceType: REF_TYPE,
      referenceId: commission.id,
      idempotencyKey: `commission:${commission.id}:${created.gatewayOrderId}`,
    },
  });
  return respond(created.gatewayOrderId, created.keyId);
}

// ---------------------------------------------------------------- settlement

// Never let the unpaid total go below 0 (drift / double-count safety).
const decrementUnpaid = (
  tx: { $executeRaw: (q: TemplateStringsArray, ...v: unknown[]) => unknown },
  memberId: string,
  amountPaise: number,
) =>
  tx.$executeRaw`UPDATE "Member" SET "unpaidCommissionPaise" = GREATEST(0, "unpaidCommissionPaise" - ${amountPaise}) WHERE "id" = ${memberId}`;

const NOTHING = { applied: false, commissionId: null, auctionId: null, amountPaise: 0, sellerId: '' };

/**
 * Settle the commission an order pays for. ONE transaction, idempotent: the
 * Commission is only moved when it is still DUE (guarded update), so verify +
 * webhook (or webhook redeliveries) produce exactly one payment effect.
 */
export async function markCommissionPaid(
  input: { paymentOrderId: string; gatewayPaymentId?: string | null },
  now = new Date(),
): Promise<{ applied: boolean; commissionId: string | null }> {
  const result = await prisma.$transaction(async (tx) => {
    const order = await tx.paymentOrder.findUnique({ where: { id: input.paymentOrderId } });
    if (!order || order.referenceType !== REF_TYPE || !order.referenceId) return NOTHING;
    const commission = await tx.commission.findUnique({
      where: { id: order.referenceId },
      select: { id: true, sellerId: true, auctionId: true, amountPaise: true },
    });
    if (!commission) return NOTHING;

    const moved = await tx.commission.updateMany({
      where: { id: commission.id, status: 'DUE' },
      data: { status: 'PAID', paidAt: now, paymentOrderId: order.id },
    });
    // The gateway took the money either way, so the order is always marked PAID.
    await tx.paymentOrder.updateMany({
      where: { id: order.id, status: { not: 'PAID' } },
      data: { status: 'PAID', gatewayPaymentId: input.gatewayPaymentId ?? null },
    });
    const applied = moved.count === 1;
    if (applied) {
      await decrementUnpaid(tx, commission.sellerId, commission.amountPaise);
    } else {
      logger.info({ commissionId: commission.id, orderId: order.id }, 'commission already settled, payment effect skipped');
    }
    return {
      applied,
      commissionId: commission.id as string | null,
      auctionId: commission.auctionId as string | null,
      amountPaise: commission.amountPaise,
      sellerId: commission.sellerId,
    };
  });

  if (result.applied && result.commissionId) {
    await enqueueNotification({
      type: 'commission-paid',
      memberId: result.sellerId,
      auctionId: result.auctionId ?? undefined,
      data: { commissionPaise: result.amountPaise },
      dedupeKey: `commission-paid:${result.commissionId}`,
    });
  }
  return { applied: result.applied, commissionId: result.commissionId };
}

/** Admin waive (POST /admin/commissions/:id/waive): DUE -> WAIVED, decrement unpaid (clamped). */
export async function waiveCommission(commissionId: string, adminId: string, now = new Date()): Promise<CommissionDTO> {
  await prisma.$transaction(async (tx) => {
    const commission = await tx.commission.findUnique({
      where: { id: commissionId },
      select: { id: true, sellerId: true, amountPaise: true },
    });
    if (!commission) throw notFound();
    const moved = await tx.commission.updateMany({
      where: { id: commissionId, status: 'DUE' },
      data: { status: 'WAIVED' },
    });
    if (moved.count !== 1) throw notDue();
    await decrementUnpaid(tx, commission.sellerId, commission.amountPaise);
  });
  logger.info({ commissionId, adminId }, 'commission waived');
  return getCommissionDTO(commissionId, now);
}

// ---------------------------------------------------------------- reminders

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Daily reminder for DUE commissions that are past dueAt or older than 3 days.
 * dedupeKey includes the date, so re-runs the same day are no-ops (one per day max).
 */
export async function runCommissionReminders(now = new Date()): Promise<{ reminded: number }> {
  const rows = await prisma.commission.findMany({
    where: {
      status: 'DUE',
      OR: [{ dueAt: { lt: now } }, { createdAt: { lte: new Date(now.getTime() - REMINDER_AFTER_DAYS * DAY_MS) } }],
    },
    select: { id: true, sellerId: true, auctionId: true, amountPaise: true, dueAt: true },
    orderBy: { dueAt: 'asc' },
    take: 500,
  });
  for (const c of rows) {
    await enqueueNotification({
      type: 'commission-due',
      memberId: c.sellerId,
      auctionId: c.auctionId,
      data: { commissionPaise: c.amountPaise, dueAt: c.dueAt.toISOString(), reminder: true },
      dedupeKey: `commission-reminder:${c.id}:${ymd(now)}`,
    });
  }
  return { reminded: rows.length };
}
