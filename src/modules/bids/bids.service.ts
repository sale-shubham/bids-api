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
import { getCheckoutMode } from '@/modules/settings/checkout-mode';
import { afterClose, closeOneTx, commissionRateBps } from '@/modules/auctions/auction-close.service';
import { isReviewWindowOpen } from '@/modules/reviews/reviews.rules';
import { enqueueNotification } from '@/modules/notify/notify.queue';
import {
  antiSnipedEndTime,
  bidState,
  reserveMet,
  resolveMaxBid,
  stateForTab,
  toBidDTO,
  validateBid,
  validateBuyNow,
  type BidAuction,
  type BidKindValue,
  type BidState,
} from '@/modules/auctions/bidding.rules';
import type { ListBidsQuery, MyBidsQuery } from './bids.validation';

type Viewer = { sub: string; role: 'BIDDER' | 'AUCTIONEER' | 'SUPER_ADMIN' } | undefined;

async function antiSnipingMinutes(): Promise<number> {
  const n = Number.parseInt((await getSetting('auction.antiSnipingMinutes')) ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Locked auction row -> the number-typed shape the pure rules take. */
function toBidAuction(a: AuctionRow): BidAuction {
  return {
    status: a.status,
    deletedAt: a.deletedAt,
    startTime: a.startTime,
    endTime: a.endTime,
    sellerId: a.sellerId,
    highestBidderId: a.highestBidderId,
    bidCount: a.bidCount,
    startingBidPaise: toPaise(a.startingBidPaise),
    currentBidPaise: toPaise(a.currentBidPaise),
    reservePricePaise: toPaiseOrNull(a.reservePricePaise),
    buyNowPricePaise: toPaiseOrNull(a.buyNowPricePaise),
  };
}

type LockedTx = Pick<typeof prisma, '$queryRaw' | 'auction' | 'member'>;

/** SELECT ... FOR UPDATE, then load the auction and the bidder. */
async function lockAndLoad(db: LockedTx, auctionId: string, memberId: string) {
  const locked = await db.$queryRaw<{ id: string }[]>`SELECT id FROM "Auction" WHERE id = ${auctionId} FOR UPDATE`;
  if (locked.length === 0) throw auctionNotFound();
  const auction = (await db.auction.findUniqueOrThrow({ where: { id: auctionId }, include: auctionInclude })) as AuctionRow;
  const bidder = await db.member.findUnique({ where: { id: memberId }, select: { id: true, name: true, isActive: true } });
  if (!bidder) throw new AppError(401, 'UNAUTHORIZED', 'Unauthorized');
  return { auction, bidder };
}

type InsertedBid = { id: string; amountPaise: bigint; kind: BidKindValue; createdAt: Date };

/**
 * Place a bid (every bid is a maximum). One interactive transaction: lock the
 * auction row (FOR UPDATE), judge the max against the locked state with
 * resolveMaxBid, store the bidder's MaxBid, insert the resulting rows in order
 * and update the auction. Two concurrent bids therefore serialise. Events /
 * notifications fire after commit and never fail the bid.
 */
export async function placeBid(memberId: string, auctionId: string, maxPaise: number) {
  assertWithinMaxPrice(await getMaxPricePaise(), maxPaise);
  const antiSniping = await antiSnipingMinutes();

  const tx = await prisma.$transaction(
    async (db) => {
      const { auction, bidder } = await lockAndLoad(db, auctionId, memberId);
      const now = new Date(); // after the lock: bids are judged in the order they win the lock
      const bidAuction = toBidAuction(auction);
      validateBid({ auction: bidAuction, bidder, now });

      const prevLeaderId = auction.highestBidderId;
      const leaderMaxRow = prevLeaderId
        ? await db.maxBid.findUnique({
            where: { auctionId_bidderId: { auctionId, bidderId: prevLeaderId } },
            select: { maxAmountPaise: true },
          })
        : null;
      const leaderMaxPaise = toPaiseOrNull(leaderMaxRow?.maxAmountPaise);
      const resolved = resolveMaxBid({
        auction: bidAuction,
        minIncrementPaise: toPaise(auction.minIncrementPaise),
        leaderMaxPaise,
        bidderId: memberId,
        maxPaise,
      });

      await db.maxBid.upsert({
        where: { auctionId_bidderId: { auctionId, bidderId: memberId } },
        create: { auctionId, bidderId: memberId, maxAmountPaise: maxPaise },
        update: { maxAmountPaise: maxPaise },
      });

      const rows: { bid: InsertedBid; bidderId: string }[] = [];
      for (const r of resolved.rows) {
        const bid = await db.bid.create({
          data: { auctionId, bidderId: r.bidderId, amountPaise: r.amountPaise, kind: r.kind },
          select: { id: true, amountPaise: true, kind: true, createdAt: true },
        });
        rows.push({ bid, bidderId: r.bidderId });
      }

      let updated = auction;
      let extended = false;
      if (rows.length > 0) {
        const endTime = antiSnipedEndTime(auction.endTime, now, antiSniping);
        extended = endTime.getTime() !== auction.endTime.getTime();
        updated = (await db.auction.update({
          where: { id: auctionId },
          data: {
            currentBidPaise: resolved.currentBidPaise,
            highestBidderId: resolved.highestBidderId,
            bidCount: { increment: rows.length },
            status: 'LIVE',
            ...(extended ? { endTime } : {}),
          },
          include: auctionInclude,
        })) as AuctionRow;
      }
      const prevLeader =
        prevLeaderId && prevLeaderId !== memberId
          ? await db.member.findUnique({ where: { id: prevLeaderId }, select: { name: true } })
          : null;
      return {
        resolved,
        rows,
        bidder,
        prevLeaderName: prevLeader?.name ?? '',
        prevLeaderMaxPaise: Math.max(leaderMaxPaise ?? bidAuction.currentBidPaise, bidAuction.currentBidPaise),
        updated,
        countBefore: auction.bidCount,
        prevLeaderId,
        extended,
        now,
      };
    },
    { maxWait: 5_000, timeout: 10_000 },
  );

  const { resolved, rows, bidder, prevLeaderName, prevLeaderMaxPaise, updated, countBefore, prevLeaderId, extended, now } = tx;
  const reservePaise = toPaiseOrNull(updated.reservePricePaise);
  const nameOf = (id: string) => (id === bidder.id ? bidder.name : prevLeaderName);
  const dtos = rows.map((r) => toBidDTO({ ...r.bid, bidder: { id: r.bidderId, name: nameOf(r.bidderId) } }, memberId));
  const tookLead = resolved.highestBidderId === memberId && !!prevLeaderId && prevLeaderId !== memberId;

  // ---- after commit: best effort ----
  try {
    // One event per inserted row, each carrying the auction state after that row.
    for (const [i, r] of rows.entries()) {
      const dto = dtos[i]!;
      await publishAuctionEvent({
        type: 'bid.placed',
        auctionId,
        currentBidPaise: dto.amountPaise,
        bidCount: countBefore + i + 1,
        endTime: updated.endTime.toISOString(),
        highestBidderId: r.bidderId,
        // Only the last row can hand the lead over; earlier rows must not trigger a bid.outbid frame.
        previousHighestBidderId: tookLead && i === rows.length - 1 ? prevLeaderId : null,
        reserveMet: reserveMet({
          reservePricePaise: reservePaise,
          bidCount: countBefore + i + 1,
          currentBidPaise: dto.amountPaise,
        }),
        bid: { id: dto.id, amountPaise: dto.amountPaise, kind: dto.kind, createdAt: dto.createdAt, bidderLabel: dto.bidderLabel },
      });
    }
    if (extended) await publishAuctionEvent({ type: 'auction.extended', auctionId, endTime: updated.endTime.toISOString() });
  } catch (err) {
    logger.warn({ err, auctionId }, 'bids: publishAuctionEvent failed');
  }

  // Only the member who lost the lead in this request is told; a requester outbid by proxy learns from the response.
  if (tookLead && prevLeaderId && rows.length > 0) {
    try {
      await enqueueNotification({
        type: 'outbid',
        memberId: prevLeaderId,
        auctionId,
        data: { newBidPaise: resolved.currentBidPaise, yourBidPaise: prevLeaderMaxPaise },
        dedupeKey: `outbid:${rows[rows.length - 1]!.bid.id}:${prevLeaderId}`,
      });
    } catch (err) {
      logger.warn({ err, auctionId }, 'bids: outbid notification failed');
    }
  }

  const mine = [...dtos].reverse().find((d) => d.isMe) ?? null;
  const auctionDetail = await buildAuctionDetail(updated, memberId, now);
  return { auction: auctionDetail, bid: mine, serverTime: new Date().toISOString(), outbidByProxy: resolved.outbidByProxy };
}

/**
 * Buy It Now: one locked transaction inserts the BUY_NOW bid, ends the auction
 * at the buy-now price and closes it (winner, commission, member stats) via
 * closeOneTx. Events and won / sold notifications fire after commit.
 */
export async function buyNow(memberId: string, auctionId: string) {
  const rateBps = await commissionRateBps();
  const checkoutMode = await getCheckoutMode();

  const tx = await prisma.$transaction(
    async (db) => {
      const { auction, bidder } = await lockAndLoad(db, auctionId, memberId);
      const now = new Date();
      const bidAuction = toBidAuction(auction);
      validateBuyNow({ auction: bidAuction, bidder, now });
      const pricePaise = bidAuction.buyNowPricePaise!; // validateBuyNow guarantees it is set

      const bid = await db.bid.create({
        data: { auctionId, bidderId: memberId, amountPaise: pricePaise, kind: 'BUY_NOW' },
        select: { id: true, amountPaise: true, kind: true, createdAt: true },
      });
      await db.maxBid.upsert({
        where: { auctionId_bidderId: { auctionId, bidderId: memberId } },
        create: { auctionId, bidderId: memberId, maxAmountPaise: pricePaise },
        update: { maxAmountPaise: pricePaise },
      });
      await db.auction.update({
        where: { id: auctionId },
        data: { currentBidPaise: pricePaise, highestBidderId: memberId, bidCount: 1, status: 'LIVE', endTime: now },
      });
      const closed = await closeOneTx(db, auctionId, now, rateBps, checkoutMode);
      if (!closed) throw new Error('buyNow: auction did not close');
      const updated = (await db.auction.findUniqueOrThrow({ where: { id: auctionId }, include: auctionInclude })) as AuctionRow;
      return { bid, bidder, closed, updated, pricePaise, reservePaise: bidAuction.reservePricePaise, now };
    },
    { maxWait: 5_000, timeout: 10_000 },
  );

  const { bid, bidder, closed, updated, pricePaise, reservePaise, now } = tx;
  const dto = toBidDTO({ ...bid, bidder: { id: bidder.id, name: bidder.name } }, memberId);
  try {
    await publishAuctionEvent({
      type: 'bid.placed',
      auctionId,
      currentBidPaise: pricePaise,
      bidCount: 1,
      endTime: updated.endTime.toISOString(),
      highestBidderId: memberId,
      previousHighestBidderId: null,
      reserveMet: reserveMet({ reservePricePaise: reservePaise, bidCount: 1, currentBidPaise: pricePaise }),
      bid: { id: dto.id, amountPaise: dto.amountPaise, kind: dto.kind, createdAt: dto.createdAt, bidderLabel: dto.bidderLabel },
    });
  } catch (err) {
    logger.warn({ err, auctionId }, 'bids: publishAuctionEvent failed');
  }
  await afterClose(closed); // auction.ended + won / sold / commission notifications

  const auctionDetail = await buildAuctionDetail(updated, memberId, now);
  return { auction: auctionDetail, serverTime: new Date().toISOString() };
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
      select: { id: true, amountPaise: true, kind: true, createdAt: true, bidder: { select: { id: true, name: true } } },
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

  const auctionIds = groups.map((g) => g.auctionId);
  const rows = (await prisma.auction.findMany({
    where: { id: { in: auctionIds } },
    include: auctionInclude,
  })) as AuctionRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const maxRows = await prisma.maxBid.findMany({
    where: { bidderId: memberId, auctionId: { in: auctionIds } },
    select: { auctionId: true, maxAmountPaise: true },
  });
  const myMax = new Map(maxRows.map((m) => [m.auctionId, toPaise(m.maxAmountPaise)]));
  const want: BidState = stateForTab(q.tab);

  const matched = groups
    .map((g) => {
      const a = byId.get(g.auctionId);
      const state = a
        ? bidState(
            { ...a, currentBidPaise: toPaise(a.currentBidPaise), reservePricePaise: toPaiseOrNull(a.reservePricePaise) },
            memberId,
            now,
          )
        : null;
      return a && state === want ? { a, g, state } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const live = want === 'WINNING' || want === 'OUTBID';
  matched.sort((x, y) =>
    live ? x.a.endTime.getTime() - y.a.endTime.getTime() : y.a.endTime.getTime() - x.a.endTime.getTime(),
  );

  const { skip, take } = offsetArgs(q);
  const pageRows = matched.slice(skip, skip + take);
  const pageIds = pageRows.map(({ a }) => a.id);
  const sales = pageIds.length
    ? await prisma.sale.findMany({
        where: { auctionId: { in: pageIds } },
        select: { id: true, auctionId: true, status: true, deliveredAt: true, releasedAt: true },
      })
    : [];
  const saleByAuction = new Map(sales.map((s) => [s.auctionId, s]));
  const reviewCandidates = pageRows
    .filter(({ a }) => isReviewWindowOpen(a, memberId, now, saleByAuction.get(a.id)))
    .map(({ a }) => a.id);
  const reviewed = reviewCandidates.length
    ? new Set(
        (await prisma.review.findMany({ where: { auctionId: { in: reviewCandidates } }, select: { auctionId: true } })).map(
          (r) => r.auctionId,
        ),
      )
    : new Set<string>();
  const items = pageRows.map(({ a, g, state }) => ({
    auction: toCard(a, now),
    canReview: reviewCandidates.includes(a.id) && !reviewed.has(a.id),
    saleId: saleByAuction.get(a.id)?.id ?? null,
    saleStatus: saleByAuction.get(a.id)?.status ?? null,
    myHighestBidPaise: toPaiseOrNull(g._max.amountPaise) ?? 0,
    myBidCount: g._count._all,
    myMaxBidPaise: myMax.get(a.id) ?? null,
    lastBidAt: (g._max.createdAt ?? new Date(0)).toISOString(),
    state,
  }));
  return { items, meta: pageMeta(matched.length, q) };
}
