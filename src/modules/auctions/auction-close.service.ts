import { prisma } from '@/core/prisma/client';
import { env } from '@/core/config/env';
import { toPaise, toPaiseOrNull } from '@/core/money';
import { logger } from '@/core/logger/logger';
import { getSetting } from '@/modules/settings/settings.service';
import { enqueueNotification } from '@/modules/notify/notify.queue';
import { publishAuctionEvent } from './auction-events';
import { COMMISSION_DUE_DAYS, commissionAmountPaise, reserveMet } from './bidding.rules';

const BATCH_SIZE = 50;
const MAX_BATCHES = 5;
const OPEN = ['SCHEDULED', 'LIVE'] as const;

export type CloseCounts = { started: number; ended: number; sold: number; unsold: number };

export async function commissionRateBps(): Promise<number> {
  const n = Number.parseInt((await getSetting('commission.rateBps')) ?? '', 10);
  return Number.isFinite(n) && n >= 0 && n <= 10_000 ? n : env.commission.rateBps;
}

export type CloseTx = Pick<typeof prisma, 'auction' | 'commission' | 'member'>;

export type Closed = {
  auctionId: string;
  sellerId: string;
  winnerId: string | null;
  /** Bids exist and the reserve (if any) was met: the auction sold. */
  sold: boolean;
  /** Had bids but the highest one stayed below the hidden reserve. */
  reserveNotMet: boolean;
  highestBidderId: string | null;
  bidCount: number;
  finalBidPaise: number;
  endedAt: Date;
  commissionPaise: number;
  rateBps: number;
  dueAt: Date | null;
};

/**
 * Close one auction inside the caller's transaction. The `WHERE status IN (SCHEDULED, LIVE)
 * AND endTime <= now` guard is the idempotency mechanism: a concurrent or repeated
 * run (or a bid that anti-sniped the end past `now`) matches 0 rows and is a no-op.
 * Returns null on no-op. Sold = bids exist AND the reserve (if any) was met.
 */
export async function closeOneTx(tx: CloseTx, auctionId: string, now: Date, rateBps: number): Promise<Closed | null> {
  const { count } = await tx.auction.updateMany({
    where: { id: auctionId, status: { in: [...OPEN] }, endTime: { lte: now }, deletedAt: null },
    data: { status: 'ENDED', endedAt: now },
  });
  if (count === 0) return null;

  // Row is now locked by our UPDATE, so these values cannot change under us.
  const a = await tx.auction.findUniqueOrThrow({
    where: { id: auctionId },
    select: { sellerId: true, highestBidderId: true, bidCount: true, currentBidPaise: true, reservePricePaise: true },
  });
  const currentBidPaise = toPaise(a.currentBidPaise);
  const sold =
    a.bidCount > 0 &&
    !!a.highestBidderId &&
    reserveMet({ reservePricePaise: toPaiseOrNull(a.reservePricePaise), bidCount: a.bidCount, currentBidPaise });
  const winnerId = sold ? a.highestBidderId : null;
  await tx.auction.update({ where: { id: auctionId }, data: { winnerId } });

  const closed: Closed = {
    auctionId,
    sellerId: a.sellerId,
    winnerId,
    sold,
    reserveNotMet: a.bidCount > 0 && !sold,
    highestBidderId: a.highestBidderId,
    bidCount: a.bidCount,
    finalBidPaise: sold ? currentBidPaise : 0,
    endedAt: now,
    commissionPaise: 0,
    rateBps,
    dueAt: null,
  };

  if (sold && winnerId) {
    closed.commissionPaise = commissionAmountPaise(currentBidPaise, rateBps);
    closed.dueAt = new Date(now.getTime() + COMMISSION_DUE_DAYS * 24 * 3600_000);
    await tx.commission.create({
      data: {
        auctionId,
        sellerId: a.sellerId,
        rateBps,
        amountPaise: closed.commissionPaise,
        status: 'DUE',
        dueAt: closed.dueAt,
      },
    });
    await tx.member.update({
      where: { id: a.sellerId },
      data: { unpaidCommissionPaise: { increment: closed.commissionPaise } },
    });
    await tx.member.update({
      where: { id: winnerId },
      data: { auctionsWon: { increment: 1 }, moneySpentPaise: { increment: currentBidPaise } },
    });
  }
  return closed;
}

async function closeOne(auctionId: string, now: Date, rateBps: number): Promise<Closed | null> {
  return prisma.$transaction((tx) => closeOneTx(tx, auctionId, now, rateBps));
}

export async function afterClose(c: Closed) {
  try {
    await publishAuctionEvent({
      type: 'auction.ended',
      auctionId: c.auctionId,
      winnerId: c.winnerId,
      finalBidPaise: c.finalBidPaise,
      bidCount: c.bidCount,
      endedAt: c.endedAt.toISOString(),
    });
  } catch (err) {
    logger.warn({ err, auctionId: c.auctionId }, 'auction-close: publishAuctionEvent failed');
  }

  if (c.sold && c.winnerId) {
    const common = { auctionId: c.auctionId, data: { finalBidPaise: c.finalBidPaise } };
    await enqueueNotification({
      type: 'auction-won',
      memberId: c.winnerId,
      ...common,
      dedupeKey: `auction-won:${c.auctionId}`,
    });
    await enqueueNotification({
      type: 'auction-sold',
      memberId: c.sellerId,
      auctionId: c.auctionId,
      data: { finalBidPaise: c.finalBidPaise, commissionPaise: c.commissionPaise, rateBps: c.rateBps },
      dedupeKey: `auction-sold:${c.auctionId}`,
    });
    await enqueueNotification({
      type: 'commission-due',
      memberId: c.sellerId,
      auctionId: c.auctionId,
      data: { commissionPaise: c.commissionPaise, dueAt: c.dueAt?.toISOString() },
      dedupeKey: `commission-due:${c.auctionId}`,
    });
  } else {
    // An unsold auction can be republished and end unsold again, so the key carries endedAt.
    await enqueueNotification({
      type: 'auction-unsold',
      memberId: c.sellerId,
      auctionId: c.auctionId,
      ...(c.reserveNotMet ? { data: { reserveNotMet: true } } : {}),
      dedupeKey: `auction-unsold:${c.auctionId}:${c.endedAt.getTime()}`,
    });
    if (c.reserveNotMet && c.highestBidderId) {
      await enqueueNotification({
        type: 'reserve-not-met',
        memberId: c.highestBidderId,
        auctionId: c.auctionId,
        dedupeKey: `reserve-not-met:${c.auctionId}:${c.endedAt.getTime()}`,
      });
    }
  }
}

/** Start due scheduled auctions, then close ended ones. Safe to run concurrently / repeatedly. */
export async function runAuctionClose(now: Date = new Date()): Promise<CloseCounts> {
  const counts: CloseCounts = { started: 0, ended: 0, sold: 0, unsold: 0 };

  const started = await prisma.auction.updateMany({
    where: { status: 'SCHEDULED', startTime: { lte: now }, endTime: { gt: now }, deletedAt: null },
    data: { status: 'LIVE' },
  });
  counts.started = started.count;

  const rateBps = await commissionRateBps();
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const due = await prisma.auction.findMany({
      where: { status: { in: [...OPEN] }, endTime: { lte: now }, deletedAt: null },
      select: { id: true },
      orderBy: { endTime: 'asc' },
      take: BATCH_SIZE,
    });
    if (due.length === 0) break;

    let closedInBatch = 0;
    for (const { id } of due) {
      try {
        const closed = await closeOne(id, now, rateBps);
        if (!closed) continue;
        closedInBatch++;
        counts.ended++;
        if (closed.sold) counts.sold++;
        else counts.unsold++;
        await afterClose(closed);
      } catch (err) {
        logger.error({ err, auctionId: id }, 'auction-close: failed to close auction');
      }
    }
    // Nothing closed (all raced or all failing) -> stop instead of re-reading the same rows.
    if (closedInBatch === 0 || due.length < BATCH_SIZE) break;
  }
  return counts;
}
