import { prisma } from '@/core/prisma/client';
import { AppError } from '@/core/errors/AppError';
import { toPaise, toPaiseOrNull } from '@/core/money';
import { logger } from '@/core/logger/logger';
import { getSetting } from '@/modules/settings/settings.service';
import { effectiveStatus } from '@/modules/auctions/auctions.serializer';
import { enqueueNotification } from '@/modules/notify/notify.queue';
import { ORDER_REUSE_MS } from '@/modules/commissions/commissions.service';
import { activeStrikeCount } from '@/modules/strikes/strikes.service';
import {
  DEPOSIT_RATE_KEY,
  DEPOSIT_THRESHOLD_KEY,
  computeDepositPaise,
  parseDepositConfig,
  requiredDepositPaise,
  type DepositConfig,
  type DepositStatusValue,
} from './deposits.rules';

const REF_TYPE = 'DEPOSIT';

type DepositRow = {
  id: string;
  auctionId: string;
  amountPaise: bigint | number;
  status: DepositStatusValue;
  heldAt: Date | null;
  refundedAt: Date | null;
  forfeitedAt: Date | null;
};

export function toDepositDTO(d: DepositRow) {
  return {
    id: d.id,
    auctionId: d.auctionId,
    amountPaise: toPaise(d.amountPaise),
    status: d.status,
    heldAt: d.heldAt,
    refundedAt: d.refundedAt,
    forfeitedAt: d.forfeitedAt,
  };
}
export type DepositDTO = ReturnType<typeof toDepositDTO>;

export async function getDepositConfig(): Promise<DepositConfig> {
  const [threshold, rate] = await Promise.all([getSetting(DEPOSIT_THRESHOLD_KEY), getSetting(DEPOSIT_RATE_KEY)]);
  return parseDepositConfig(threshold, rate);
}

/** The deposit stored on an auction for a starting bid (null = none). */
export async function depositForStartingBid(startingBidPaise: number): Promise<number | null> {
  return computeDepositPaise(startingBidPaise, await getDepositConfig());
}

type FactsAuction = { depositPaise: bigint | number | null; startingBidPaise: bigint | number; currentBidPaise: bigint | number };
type FactsDb = {
  auctionDeposit: Pick<typeof prisma.auctionDeposit, 'findUnique'>;
  strike: Pick<typeof prisma.strike, 'count'>;
};

/** Deposit facts for one member on one auction (what validateBid / validateBuyNow take). */
export async function loadDepositFacts(
  db: FactsDb,
  auction: FactsAuction,
  auctionId: string,
  memberId: string,
  rateBps: number,
  now = new Date(),
): Promise<{ requiredPaise: number; held: boolean; status: DepositStatusValue | null }> {
  const auctionDepositPaise = toPaiseOrNull(auction.depositPaise);
  const ownDeposit = auctionDepositPaise !== null && auctionDepositPaise > 0;
  const [row, strikes] = await Promise.all([
    db.auctionDeposit.findUnique({ where: { auctionId_memberId: { auctionId, memberId } }, select: { status: true } }),
    ownDeposit ? Promise.resolve(0) : activeStrikeCount(db, memberId, now),
  ]);
  const requiredPaise = requiredDepositPaise({
    auctionDepositPaise,
    activeStrikes: strikes ?? 0,
    startingBidPaise: toPaise(auction.startingBidPaise),
    currentBidPaise: toPaise(auction.currentBidPaise),
    rateBps,
  });
  const status = (row?.status ?? null) as DepositStatusValue | null;
  return { requiredPaise, held: status === 'HELD', status };
}

// ---------------------------------------------------------------- checkout

/** POST /auctions/:id/deposit/checkout: create (or reuse) a Razorpay order for the viewer's deposit. */
export async function checkout(memberId: string, auctionId: string, now = new Date()) {
  const auction = await prisma.auction.findUnique({
    where: { id: auctionId },
    select: {
      id: true,
      title: true,
      status: true,
      deletedAt: true,
      startTime: true,
      endTime: true,
      sellerId: true,
      startingBidPaise: true,
      currentBidPaise: true,
      depositPaise: true,
    },
  });
  if (!auction || auction.status === 'CANCELLED' || auction.deletedAt) throw new AppError(404, 'AUCTION_NOT_FOUND', 'Auction not found');
  const eff = effectiveStatus(auction, now);
  if (eff !== 'SCHEDULED' && eff !== 'LIVE') throw new AppError(409, 'AUCTION_ENDED', 'This auction has ended');
  if (auction.sellerId === memberId) throw new AppError(403, 'OWN_AUCTION', 'You cannot bid on your own auction');

  const { rateBps } = await getDepositConfig();
  const facts = await loadDepositFacts(prisma, auction, auctionId, memberId, rateBps, now);
  if (facts.held) throw new AppError(409, 'DEPOSIT_ALREADY_HELD', 'Your deposit for this auction is already held');
  if (facts.requiredPaise <= 0) throw new AppError(409, 'DEPOSIT_NOT_REQUIRED', 'No deposit is required to bid on this auction');

  const member = await prisma.member.findUnique({ where: { id: memberId }, select: { name: true, email: true, phone: true } });
  if (!member) throw new AppError(401, 'UNAUTHORIZED', 'Unauthorized');

  const deposit = await prisma.auctionDeposit.upsert({
    where: { auctionId_memberId: { auctionId, memberId } },
    create: { auctionId, memberId, amountPaise: facts.requiredPaise, status: 'PENDING' },
    update: { amountPaise: facts.requiredPaise, status: 'PENDING' },
    select: { id: true },
  });

  const { paymentProvider } = await import('@/providers/payment');
  const amountPaise = facts.requiredPaise;
  const description = `Refundable deposit for "${auction.title}"`.slice(0, 255);
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
      referenceId: deposit.id,
      status: 'CREATED',
      amountPaise,
      createdAt: { gte: new Date(now.getTime() - ORDER_REUSE_MS) },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) return respond(existing.gatewayOrderId, paymentProvider.publicKey);

  // Razorpay receipt max 40 chars: "d_" + 12 chars of the id + "_" + base36 time (<= 9).
  const receipt = `d_${deposit.id.slice(-12)}_${now.getTime().toString(36)}`;
  const created = await paymentProvider.createOrder({
    amountPaise,
    receipt,
    notes: { depositId: deposit.id, auctionId, memberId },
  });
  await prisma.paymentOrder.create({
    data: {
      memberId,
      gatewayOrderId: created.gatewayOrderId,
      amountPaise,
      referenceType: REF_TYPE,
      referenceId: deposit.id,
      idempotencyKey: `deposit:${deposit.id}:${created.gatewayOrderId}`,
    },
  });
  return respond(created.gatewayOrderId, created.keyId);
}

// ---------------------------------------------------------------- settlement

const NOTHING = { applied: false, depositId: null as string | null };

/**
 * Settle the deposit an order pays for. ONE transaction, idempotent: the deposit only moves when it is
 * still PENDING (guarded update), so verify + webhook (or redeliveries) produce exactly one effect.
 */
export async function markDepositHeld(
  input: { paymentOrderId: string; gatewayPaymentId?: string | null },
  now = new Date(),
): Promise<{ applied: boolean; depositId: string | null }> {
  const result = await prisma.$transaction(async (tx) => {
    const order = await tx.paymentOrder.findUnique({ where: { id: input.paymentOrderId } });
    if (!order || order.referenceType !== REF_TYPE || !order.referenceId) return { ...NOTHING, deposit: null };
    const deposit = await tx.auctionDeposit.findUnique({
      where: { id: order.referenceId },
      select: { id: true, auctionId: true, memberId: true, amountPaise: true },
    });
    if (!deposit) return { ...NOTHING, deposit: null };

    const moved = await tx.auctionDeposit.updateMany({
      where: { id: deposit.id, status: 'PENDING' },
      data: { status: 'HELD', heldAt: now, paymentOrderId: order.id, gatewayPaymentId: input.gatewayPaymentId ?? null },
    });
    // The gateway took the money either way, so the order is always marked PAID.
    await tx.paymentOrder.updateMany({
      where: { id: order.id, status: { not: 'PAID' } },
      data: { status: 'PAID', gatewayPaymentId: input.gatewayPaymentId ?? null },
    });
    const applied = moved.count === 1;
    if (!applied) logger.info({ depositId: deposit.id, orderId: order.id }, 'deposit already settled (or not pending), payment effect skipped');
    return { applied, depositId: deposit.id as string | null, deposit };
  });

  if (result.applied && result.deposit) {
    const { deposit } = result;
    await enqueueNotification({
      type: 'deposit-held',
      memberId: deposit.memberId,
      auctionId: deposit.auctionId,
      data: { amountPaise: toPaise(deposit.amountPaise) },
      dedupeKey: `deposit-held:${deposit.id}`,
    });
  }
  return { applied: result.applied, depositId: result.depositId };
}

export async function getDepositDTO(depositId: string): Promise<DepositDTO | null> {
  const row = await prisma.auctionDeposit.findUnique({
    where: { id: depositId },
    select: { id: true, auctionId: true, amountPaise: true, status: true, heldAt: true, refundedAt: true, forfeitedAt: true },
  });
  return row ? toDepositDTO(row as DepositRow) : null;
}

// ---------------------------------------------------------------- viewer view (auction detail)

/** `{ requiredPaise, status }` for the viewer on an auction. */
export async function viewerDeposit(auction: FactsAuction & { id: string }, memberId: string, now = new Date(), db: FactsDb = prisma) {
  const { rateBps } = await getDepositConfig();
  const f = await loadDepositFacts(db, auction, auction.id, memberId, rateBps, now);
  return { requiredPaise: f.requiredPaise, status: f.status };
}
