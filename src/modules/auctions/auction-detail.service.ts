import { prisma } from '@/core/prisma/client';
import { toPaise, toPaiseOrNull } from '@/core/money';
import { effectiveStatus, toDetail, type AuctionContact, type AuctionRow } from './auctions.serializer';
import { provisionalWinnerId, toBidDTO } from './bidding.rules';
import { viewerDeposit } from '@/modules/deposits/deposits.service';
import { categoryContext } from '@/modules/categories/categories.service';
import { isReviewWindowOpen, reviewInclude, toReviewDTO } from '@/modules/reviews/reviews.rules';

const RECENT_BIDS = 5;
const contactSelect = { name: true, email: true, phone: true } as const;

type Db = Pick<typeof prisma, 'bid' | 'member' | 'watchlist' | 'maxBid' | 'review' | 'sale' | 'auctionDeposit' | 'strike'>;

/**
 * AuctionDetail with the viewer-specific extras: latest 5 bids (masked),
 * the viewer's highest bid, and the post-auction contact card (winner sees the
 * seller, seller sees the winner, everyone else null), the viewer's own max bid,
 * and `reservePricePaise` for the seller / a SUPER_ADMIN only.
 */
export async function buildAuctionDetail(
  row: AuctionRow,
  viewerId: string | null,
  now = new Date(),
  db: Db = prisma,
  viewerRole: string | null = null,
) {
  const [bids, mine, myMax, contact, watcherCount, watching, reviewRow, saleRow, deposit, catCtx] = await Promise.all([
    db.bid.findMany({
      where: { auctionId: row.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: RECENT_BIDS,
      select: { id: true, amountPaise: true, kind: true, createdAt: true, bidder: { select: { id: true, name: true } } },
    }),
    viewerId
      ? db.bid.aggregate({ where: { auctionId: row.id, bidderId: viewerId }, _max: { amountPaise: true } })
      : Promise.resolve(null),
    viewerId
      ? db.maxBid.findUnique({
          where: { auctionId_bidderId: { auctionId: row.id, bidderId: viewerId } },
          select: { maxAmountPaise: true },
        })
      : Promise.resolve(null),
    findContact(row, viewerId, now, db),
    db.watchlist.count({ where: { auctionId: row.id } }),
    viewerId
      ? db.watchlist.findUnique({
          where: { memberId_auctionId: { memberId: viewerId, auctionId: row.id } },
          select: { memberId: true },
        })
      : Promise.resolve(null),
    db.review.findUnique({ where: { auctionId: row.id }, include: reviewInclude }),
    // Latest sale first: a cancelled sale can be followed by a second-chance sale.
    db.sale.findFirst({
      where: { auctionId: row.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, payBy: true, buyerId: true, sellerId: true, deliveredAt: true, releasedAt: true },
    }),
    viewerId ? viewerDeposit(row, viewerId, now, db) : Promise.resolve(null),
    categoryContext(row.categoryId),
  ]);
  const seesSale = !!viewerId && !!saleRow && (viewerId === saleRow.buyerId || viewerId === saleRow.sellerId || viewerRole === 'SUPER_ADMIN');
  const seesReserve = !!viewerId && (viewerId === row.sellerId || viewerRole === 'SUPER_ADMIN');
  return {
    ...toDetail(row, now, catCtx),
    ...(seesReserve ? { reservePricePaise: toPaiseOrNull(row.reservePricePaise) } : {}),
    myMaxBidPaise: toPaiseOrNull(myMax?.maxAmountPaise),
    recentBids: bids.map((b) => toBidDTO(b, viewerId)),
    myHighestBidPaise: toPaiseOrNull(mine?._max.amountPaise),
    contact,
    isWatching: !!watching,
    watcherCount,
    review: reviewRow && !reviewRow.hiddenAt ? toReviewDTO(reviewRow) : null,
    canReview: !reviewRow && isReviewWindowOpen(row, viewerId, now, saleRow),
    deposit,
    sale: seesSale && saleRow ? { id: saleRow.id, status: saleRow.status, payBy: saleRow.payBy } : null,
  };
}

async function findContact(row: AuctionRow, viewerId: string | null, now: Date, db: Db): Promise<AuctionContact | null> {
  if (!viewerId || effectiveStatus(row, now) !== 'ENDED') return null;
  // The close job stamps winnerId; until it runs the highest bidder wins, if the reserve is met.
  const winnerId = provisionalWinnerId({
    winnerId: row.winnerId,
    highestBidderId: row.highestBidderId,
    reservePricePaise: toPaiseOrNull(row.reservePricePaise),
    bidCount: row.bidCount,
    currentBidPaise: toPaise(row.currentBidPaise),
  });
  if (!winnerId) return null;
  if (viewerId === winnerId) {
    const seller = await db.member.findUnique({ where: { id: row.sellerId }, select: contactSelect });
    return seller ? { role: 'SELLER', ...seller } : null;
  }
  if (viewerId === row.sellerId) {
    const winner = await db.member.findUnique({ where: { id: winnerId }, select: contactSelect });
    return winner ? { role: 'WINNER', ...winner } : null;
  }
  return null;
}
