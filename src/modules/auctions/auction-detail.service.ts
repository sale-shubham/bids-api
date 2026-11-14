import { prisma } from '@/core/prisma/client';
import { effectiveStatus, toDetail, type AuctionContact, type AuctionRow } from './auctions.serializer';
import { toBidDTO } from './bidding.rules';

const RECENT_BIDS = 5;
const contactSelect = { name: true, email: true, phone: true } as const;

type Db = Pick<typeof prisma, 'bid' | 'member' | 'watchlist'>;

/**
 * AuctionDetail with the viewer-specific extras: latest 5 bids (masked),
 * the viewer's highest bid, and the post-auction contact card (winner sees the
 * seller, seller sees the winner, everyone else null).
 */
export async function buildAuctionDetail(row: AuctionRow, viewerId: string | null, now = new Date(), db: Db = prisma) {
  const [bids, mine, contact, watcherCount, watching] = await Promise.all([
    db.bid.findMany({
      where: { auctionId: row.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: RECENT_BIDS,
      select: { id: true, amountPaise: true, createdAt: true, bidder: { select: { id: true, name: true } } },
    }),
    viewerId
      ? db.bid.aggregate({ where: { auctionId: row.id, bidderId: viewerId }, _max: { amountPaise: true } })
      : Promise.resolve(null),
    findContact(row, viewerId, now, db),
    db.watchlist.count({ where: { auctionId: row.id } }),
    viewerId
      ? db.watchlist.findUnique({
          where: { memberId_auctionId: { memberId: viewerId, auctionId: row.id } },
          select: { memberId: true },
        })
      : Promise.resolve(null),
  ]);
  return {
    ...toDetail(row, now),
    recentBids: bids.map((b) => toBidDTO(b, viewerId)),
    myHighestBidPaise: mine?._max.amountPaise ?? null,
    contact,
    isWatching: !!watching,
    watcherCount,
  };
}

async function findContact(row: AuctionRow, viewerId: string | null, now: Date, db: Db): Promise<AuctionContact | null> {
  if (!viewerId || effectiveStatus(row, now) !== 'ENDED') return null;
  // The close job stamps winnerId; until it runs the highest bidder is the winner.
  const winnerId = row.winnerId ?? (row.bidCount > 0 ? row.highestBidderId : null);
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
