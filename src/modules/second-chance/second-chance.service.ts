import { prisma } from '@/core/prisma/client';
import { AppError } from '@/core/errors/AppError';
import { toPaise } from '@/core/money';
import { logger } from '@/core/logger/logger';
import { enqueueNotification } from '@/modules/notify/notify.queue';
import { commissionRateBps } from '@/modules/auctions/auction-close.service';
import { commissionAmountPaise } from '@/modules/auctions/bidding.rules';
import { payByFrom } from '@/modules/sales/sales.rules';
import { OFFER_TTL_MS, pickRunnerUp, toOfferDTO, type OfferStatusValue } from './second-chance.rules';

const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code === 'P2002';
const offerNotFound = () => new AppError(404, 'OFFER_NOT_FOUND', 'Offer not found');

const offerSelect = {
  id: true,
  saleId: true,
  auctionId: true,
  bidderId: true,
  amountPaise: true,
  status: true,
  expiresAt: true,
  respondedAt: true,
  newSaleId: true,
  createdAt: true,
  auction: { select: { id: true, title: true, images: true, sellerId: true } },
} as const;

// ---------------------------------------------------------------- seller: make the offer

/** The runner-up of an auction: not a buyer of any sale on it, an active member, highest max bid. */
export async function findRunnerUp(auctionId: string) {
  const buyers = await prisma.sale.findMany({ where: { auctionId }, select: { buyerId: true } });
  const excluded = [...new Set(buyers.map((b) => b.buyerId))];
  const bidderWhere = { auctionId, bidderId: { notIn: excluded }, bidder: { isActive: true } };
  const [maxRows, bidRows] = await Promise.all([
    prisma.maxBid.findMany({ where: bidderWhere, select: { bidderId: true, maxAmountPaise: true } }),
    prisma.bid.groupBy({ by: ['bidderId'], where: bidderWhere, _max: { amountPaise: true } }),
  ]);
  return pickRunnerUp(
    maxRows.map((m) => ({ bidderId: m.bidderId, maxAmountPaise: toPaise(m.maxAmountPaise) })),
    bidRows.flatMap((b) => (b._max.amountPaise === null ? [] : [{ bidderId: b.bidderId, amountPaise: toPaise(b._max.amountPaise) }])),
  );
}

/** POST /sales/:id/second-chance: the seller of a CANCELLED sale offers the item to the runner-up at their max. */
export async function createOffer(sellerId: string, saleId: string, now = new Date()) {
  const sale = await prisma.sale.findFirst({
    where: { id: saleId, sellerId },
    select: { id: true, auctionId: true, status: true, auction: { select: { id: true, title: true, images: true } } },
  });
  if (!sale) throw new AppError(404, 'SALE_NOT_FOUND', 'Sale not found');
  if (sale.status !== 'CANCELLED') throw new AppError(409, 'SALE_INVALID_STATE', 'A second-chance offer needs a cancelled sale');
  if (await prisma.secondChanceOffer.findUnique({ where: { saleId }, select: { id: true } })) {
    throw new AppError(409, 'OFFER_EXISTS', 'A second-chance offer was already made for this sale');
  }
  const open = await prisma.sale.findFirst({
    where: { auctionId: sale.auctionId, status: { notIn: ['CANCELLED', 'REFUNDED'] } },
    select: { id: true },
  });
  if (open) throw new AppError(409, 'SALE_INVALID_STATE', 'This auction already has an open sale');

  const runnerUp = await findRunnerUp(sale.auctionId);
  if (!runnerUp) throw new AppError(409, 'NO_RUNNER_UP', 'There is no other bidder to offer this item to');

  let offer;
  try {
    offer = await prisma.secondChanceOffer.create({
      data: {
        saleId,
        auctionId: sale.auctionId,
        bidderId: runnerUp.bidderId,
        amountPaise: runnerUp.amountPaise,
        expiresAt: new Date(now.getTime() + OFFER_TTL_MS),
      },
      select: { id: true, auctionId: true, amountPaise: true, status: true, expiresAt: true, respondedAt: true, newSaleId: true, createdAt: true },
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(409, 'OFFER_EXISTS', 'A second-chance offer was already made for this sale');
    throw err;
  }
  await enqueueNotification({
    type: 'second-chance-offer',
    memberId: runnerUp.bidderId,
    auctionId: sale.auctionId,
    data: { offerId: offer.id, amountPaise: runnerUp.amountPaise, expiresAt: offer.expiresAt.toISOString() },
    dedupeKey: `second-chance-offer:${offer.id}`,
  });
  return { offer: toOfferDTO({ ...offer, status: offer.status as OfferStatusValue }, sale.auction, now) };
}

// ---------------------------------------------------------------- bidder

async function loadMine(bidderId: string, id: string) {
  const row = await prisma.secondChanceOffer.findFirst({ where: { id, bidderId }, select: offerSelect });
  if (!row) throw offerNotFound();
  return row;
}

export async function listMine(bidderId: string, now = new Date()) {
  const rows = await prisma.secondChanceOffer.findMany({
    where: { bidderId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: offerSelect,
    take: 100,
  });
  const items = rows.map((r) => toOfferDTO({ ...r, status: r.status as OfferStatusValue }, r.auction, now));
  const rank = (s: string) => (s === 'PENDING' ? 0 : 1);
  return { items: items.sort((a, b) => rank(a.status) - rank(b.status)) };
}

export async function getOne(bidderId: string, id: string, now = new Date()) {
  const r = await loadMine(bidderId, id);
  return { offer: toOfferDTO({ ...r, status: r.status as OfferStatusValue }, r.auction, now) };
}

/** POST /second-chance-offers/:id/accept: create the new Sale, hand the auction to the bidder. */
export async function acceptOffer(bidderId: string, id: string, now = new Date()) {
  const offer = await loadMine(bidderId, id);
  if (offer.status !== 'PENDING') throw new AppError(409, 'OFFER_NOT_PENDING', 'This offer was already answered');
  if (offer.expiresAt.getTime() <= now.getTime()) throw new AppError(409, 'OFFER_EXPIRED', 'This offer has expired');

  const payout = await prisma.sellerPayoutAccount.findUnique({ where: { sellerId: offer.auction.sellerId }, select: { status: true } });
  if (payout?.status !== 'ACTIVE') throw new AppError(409, 'PAYOUT_ACCOUNT_INACTIVE', 'The seller cannot receive payments right now');
  const rateBps = await commissionRateBps();
  const amountPaise = toPaise(offer.amountPaise);

  const result = await prisma.$transaction(async (tx) => {
    const moved = await tx.secondChanceOffer.updateMany({
      where: { id, status: 'PENDING', expiresAt: { gt: now } },
      data: { status: 'ACCEPTED', respondedAt: now },
    });
    if (moved.count === 0) throw new AppError(409, 'OFFER_NOT_PENDING', 'This offer was already answered');
    const cancelled = await tx.sale.findUnique({ where: { id: offer.saleId }, select: { buyerId: true } });
    const sale = await tx.sale.create({
      data: {
        auctionId: offer.auctionId,
        buyerId: bidderId,
        sellerId: offer.auction.sellerId,
        itemPaise: amountPaise,
        shippingFeePaise: 0,
        amountPaise,
        commissionPaise: commissionAmountPaise(amountPaise, rateBps),
        rateBps,
        payBy: payByFrom(now),
      },
      select: { id: true },
    });
    await tx.secondChanceOffer.update({ where: { id }, data: { newSaleId: sale.id } });
    await tx.auction.update({ where: { id: offer.auctionId }, data: { winnerId: bidderId } });
    if (cancelled) {
      await tx.member.update({ where: { id: cancelled.buyerId }, data: { auctionsWon: { decrement: 1 } } });
    }
    await tx.member.update({ where: { id: bidderId }, data: { auctionsWon: { increment: 1 }, moneySpentPaise: { increment: amountPaise } } });
    return sale;
  });

  await enqueueNotification({
    type: 'second-chance-accepted',
    memberId: offer.auction.sellerId,
    auctionId: offer.auctionId,
    data: { offerId: id, saleId: result.id, amountPaise },
    dedupeKey: `second-chance-accepted:${id}`,
  });
  const after = await loadMine(bidderId, id);
  return { offer: toOfferDTO({ ...after, status: after.status as OfferStatusValue }, after.auction, now), saleId: result.id };
}

export async function declineOffer(bidderId: string, id: string, now = new Date()) {
  const offer = await loadMine(bidderId, id);
  const { count } = await prisma.secondChanceOffer.updateMany({
    where: { id, status: 'PENDING' },
    data: { status: 'DECLINED', respondedAt: now },
  });
  if (count === 0) throw new AppError(409, 'OFFER_NOT_PENDING', 'This offer was already answered');
  await enqueueNotification({
    type: 'second-chance-declined',
    memberId: offer.auction.sellerId,
    auctionId: offer.auctionId,
    data: { offerId: id, saleId: offer.saleId },
    dedupeKey: `second-chance-declined:${id}`,
  });
  const after = await loadMine(bidderId, id);
  return { offer: toOfferDTO({ ...after, status: after.status as OfferStatusValue }, after.auction, now) };
}

// ---------------------------------------------------------------- job

/** PENDING offers past `expiresAt` -> EXPIRED (idempotent). Returns how many moved. */
export async function expireOffers(now = new Date()): Promise<number> {
  try {
    const { count } = await prisma.secondChanceOffer.updateMany({
      where: { status: 'PENDING', expiresAt: { lte: now } },
      data: { status: 'EXPIRED' },
    });
    return count;
  } catch (err) {
    logger.error({ err }, 'second-chance: expiring offers failed');
    return 0;
  }
}
