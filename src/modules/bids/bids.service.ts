import { prisma } from '@/core/prisma/client';
import { AppError } from '@/core/errors/AppError';
import { toPaise, toPaiseOrNull } from '@/core/money';
import { logger } from '@/core/logger/logger';
import { offsetArgs, pageMeta } from '@/core/http/pagination';
import { getSetting } from '@/modules/settings/settings.service';
import { assertWithinMaxPrice, getMaxPricePaise } from '@/modules/settings/max-price';
import { auctionInclude, effectiveStatus, toCard, type AuctionRow } from '@/modules/auctions/auctions.serializer';
import { buildAuctionDetail } from '@/modules/auctions/auction-detail.service';
import { auctionNotFound } from '@/modules/auctions/auctions.service';
import { publishAuctionEvent } from '@/modules/auctions/auction-events';
import { enqueueNotification } from '@/modules/notify/notify.queue';
import {
  antiSnipedEndTime,
  bidState,
  stateForTab,
  toBidDTO,
  validateBid,
  type BidState,
} from '@/modules/auctions/bidding.rules';
import type { ListBidsQuery, MyBidsQuery } from './bids.validation';

type Viewer = { sub: string; role: 'BIDDER' | 'AUCTIONEER' | 'SUPER_ADMIN' } | undefined;

async function antiSnipingMinutes(): Promise<number> {
  const n = Number.parseInt((await getSetting('auction.antiSnipingMinutes')) ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Place a bid. One interactive transaction: lock the auction row (FOR UPDATE),
 * validate against the locked state, insert the bid, update the auction. Two
 * concurrent bids therefore serialise and the second is validated against the
 * first. Notifications / events fire after commit and never fail the bid.
 */
export async function placeBid(memberId: string, auctionId: string, amountPaise: number) {
  assertWithinMaxPrice(await getMaxPricePaise(), amountPaise);
  const antiSniping = await antiSnipingMinutes();

  const tx = await prisma.$transaction(
    async (db) => {
      const locked = await db.$queryRaw<{ id: string }[]>`SELECT id FROM "Auction" WHERE id = ${auctionId} FOR UPDATE`;
      if (locked.length === 0) throw auctionNotFound();

      const auction = (await db.auction.findUniqueOrThrow({ where: { id: auctionId }, include: auctionInclude })) as AuctionRow;
      const bidder = await db.member.findUnique({ where: { id: memberId }, select: { id: true, name: true, isActive: true } });
      if (!bidder) throw new AppError(401, 'UNAUTHORIZED', 'Unauthorized');

      const now = new Date(); // after the lock: bids are judged in the order they win the lock
      validateBid({
        auction: {
          ...auction,
          startingBidPaise: toPaise(auction.startingBidPaise),
          currentBidPaise: toPaise(auction.currentBidPaise),
        },
        bidder,
        amountPaise,
        now,
        minIncrementPaise: toPaise(auction.minIncrementPaise),
      });

      const bid = await db.bid.create({
        data: { auctionId, bidderId: memberId, amountPaise },
        select: { id: true, amountPaise: true, createdAt: true },
      });
      const endTime = antiSnipedEndTime(auction.endTime, now, antiSniping);
      const extended = endTime.getTime() !== auction.endTime.getTime();
      const updated = (await db.auction.update({
        where: { id: auctionId },
        data: {
          currentBidPaise: amountPaise,
          highestBidderId: memberId,
          bidCount: { increment: 1 },
          status: 'LIVE',
          ...(extended ? { endTime } : {}),
        },
        include: auctionInclude,
      })) as AuctionRow;
      return { bid, bidder, updated, previousHighestBidderId: auction.highestBidderId, extended, now };
    },
    { maxWait: 5_000, timeout: 10_000 },
  );

  const { bid, bidder, updated, previousHighestBidderId, extended, now } = tx;
  const bidDto = toBidDTO({ ...bid, bidder: { id: bidder.id, name: bidder.name } }, memberId);

  // ---- after commit: best effort ----
  try {
    await publishAuctionEvent({
      type: 'bid.placed',
      auctionId,
      currentBidPaise: toPaise(updated.currentBidPaise),
      bidCount: updated.bidCount,
      endTime: updated.endTime.toISOString(),
      highestBidderId: memberId,
      previousHighestBidderId,
      bid: { id: bidDto.id, amountPaise: bidDto.amountPaise, createdAt: bidDto.createdAt, bidderLabel: bidDto.bidderLabel },
    });
    if (extended) await publishAuctionEvent({ type: 'auction.extended', auctionId, endTime: updated.endTime.toISOString() });
  } catch (err) {
    logger.warn({ err, auctionId }, 'bids: publishAuctionEvent failed');
  }

  if (previousHighestBidderId) {
    const prev = await prisma.bid
      .aggregate({ where: { auctionId, bidderId: previousHighestBidderId }, _max: { amountPaise: true } })
      .catch(() => null);
    await enqueueNotification({
      type: 'outbid',
      memberId: previousHighestBidderId,
      auctionId,
      data: { newBidPaise: amountPaise, yourBidPaise: toPaiseOrNull(prev?._max.amountPaise) ?? 0 },
      dedupeKey: `outbid:${bid.id}:${previousHighestBidderId}`,
    });
  }

  const auctionDetail = await buildAuctionDetail(updated, memberId, now);
  return { auction: auctionDetail, bid: bidDto, serverTime: new Date().toISOString() };
}

/** GET /auctions/:id/bids — public; cancelled/deleted auctions 404 (except seller / admin). */
export async function listBids(auctionId: string, q: ListBidsQuery, viewer: Viewer) {
  const auction = await prisma.auction.findUnique({
    where: { id: auctionId },
    select: { sellerId: true, status: true, deletedAt: true, startTime: true, endTime: true },
  });
  if (!auction) throw auctionNotFound();
  const privileged = !!viewer && (viewer.role === 'SUPER_ADMIN' || viewer.sub === auction.sellerId);
  if (effectiveStatus(auction) === 'CANCELLED' && !privileged) throw auctionNotFound();

  const { skip, take } = offsetArgs(q);
  const [rows, total] = await Promise.all([
    prisma.bid.findMany({
      where: { auctionId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip,
      take,
      select: { id: true, amountPaise: true, createdAt: true, bidder: { select: { id: true, name: true } } },
    }),
    prisma.bid.count({ where: { auctionId } }),
  ]);
  return { items: rows.map((b) => toBidDTO(b, viewer?.sub)), meta: pageMeta(total, q) };
}

/**
 * GET /bids/mine. Groups the member's bids per auction, derives each state from
 * the (time-based) effective status, filters by tab and pages in memory — a
 * member's distinct auctions are few. Live tabs: ending soonest first; ended
 * tabs: most recently ended first.
 */
export async function listMyBids(memberId: string, q: MyBidsQuery, now = new Date()) {
  const groups = await prisma.bid.groupBy({
    by: ['auctionId'],
    where: { bidderId: memberId },
    _max: { amountPaise: true, createdAt: true },
    _count: { _all: true },
  });
  if (groups.length === 0) return { items: [], meta: pageMeta(0, q) };

  const rows = (await prisma.auction.findMany({
    where: { id: { in: groups.map((g) => g.auctionId) } },
    include: auctionInclude,
  })) as AuctionRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const want: BidState = stateForTab(q.tab);

  const matched = groups
    .map((g) => {
      const a = byId.get(g.auctionId);
      const state = a ? bidState(a, memberId, now) : null;
      return a && state === want ? { a, g, state } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const live = want === 'WINNING' || want === 'OUTBID';
  matched.sort((x, y) =>
    live ? x.a.endTime.getTime() - y.a.endTime.getTime() : y.a.endTime.getTime() - x.a.endTime.getTime(),
  );

  const { skip, take } = offsetArgs(q);
  const items = matched.slice(skip, skip + take).map(({ a, g, state }) => ({
    auction: toCard(a, now),
    myHighestBidPaise: toPaiseOrNull(g._max.amountPaise) ?? 0,
    myBidCount: g._count._all,
    lastBidAt: (g._max.createdAt ?? new Date(0)).toISOString(),
    state,
  }));
  return { items, meta: pageMeta(matched.length, q) };
}
