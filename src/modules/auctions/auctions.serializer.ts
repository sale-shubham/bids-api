import type { Prisma } from '@prisma/client';
import { toPaise, toPaiseOrNull } from '@/core/money';
import { reserveMet, type BidDTO } from './bidding.rules';
import { ratingAvg, type ReviewDTO } from '@/modules/reviews/reviews.rules';

export type EffectiveStatus = 'SCHEDULED' | 'LIVE' | 'ENDED' | 'CANCELLED';

type StatusInput = {
  status: 'SCHEDULED' | 'LIVE' | 'ENDED' | 'CANCELLED';
  deletedAt: Date | null;
  startTime: Date;
  endTime: Date;
};

/**
 * Status as the world should see it, derived from time: the stored status lags
 * (the close job runs every minute), so it is never trusted alone.
 */
export function effectiveStatus(a: StatusInput, now: Date = new Date()): EffectiveStatus {
  if (a.status === 'CANCELLED' || a.deletedAt) return 'CANCELLED';
  if (a.status === 'ENDED' || now.getTime() >= a.endTime.getTime()) return 'ENDED';
  if (now.getTime() < a.startTime.getTime()) return 'SCHEDULED';
  return 'LIVE';
}

export const sellerSelect = { id: true, name: true, avatarUrl: true, ratingCount: true, ratingSum: true, verifiedAt: true } as const;
export const auctionInclude = { seller: { select: sellerSelect } } as const;
export type AuctionRow = Prisma.AuctionGetPayload<{ include: typeof auctionInclude }>;

export function toCard(a: AuctionRow, now: Date = new Date()) {
  return {
    id: a.id,
    title: a.title,
    category: a.category,
    condition: a.condition,
    coverImage: a.images[0] ?? null,
    startingBidPaise: toPaise(a.startingBidPaise),
    currentBidPaise: toPaise(a.currentBidPaise),
    bidCount: a.bidCount,
    // Buy It Now disappears after the first bid. The reserve amount itself is never serialised here.
    buyNowPricePaise: a.bidCount > 0 ? null : toPaiseOrNull(a.buyNowPricePaise),
    hasReserve: toPaiseOrNull(a.reservePricePaise) !== null,
    reserveMet: reserveMet({
      reservePricePaise: toPaiseOrNull(a.reservePricePaise),
      bidCount: a.bidCount,
      currentBidPaise: toPaise(a.currentBidPaise),
    }),
    startTime: a.startTime.toISOString(),
    endTime: a.endTime.toISOString(),
    status: effectiveStatus(a, now),
    seller: {
      id: a.seller.id,
      name: a.seller.name,
      avatarUrl: a.seller.avatarUrl,
      ratingAvg: ratingAvg(a.seller.ratingSum, a.seller.ratingCount),
      ratingCount: a.seller.ratingCount,
      verified: !!a.seller.verifiedAt,
    },
  };
}

export type AuctionContact = { role: 'SELLER' | 'WINNER'; name: string; email: string; phone: string | null };

// recentBids / myHighestBidPaise / contact are filled by auction-detail.service
// (they need extra queries); create/patch/republish responses carry the empty defaults.
export function toDetail(a: AuctionRow, now: Date = new Date()) {
  return {
    ...toCard(a, now),
    description: a.description,
    images: a.images,
    minIncrementPaise: toPaise(a.minIncrementPaise),
    depositPaise: toPaiseOrNull(a.depositPaise),
    highestBidderId: a.highestBidderId,
    winnerId: a.winnerId,
    endedAt: a.endedAt ? a.endedAt.toISOString() : null,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    recentBids: [] as BidDTO[],
    myHighestBidPaise: null as number | null,
    myMaxBidPaise: null as number | null,
    contact: null as AuctionContact | null,
    isWatching: false,
    watcherCount: 0,
    review: null as ReviewDTO | null,
    canReview: false,
    deposit: null as { requiredPaise: number; status: 'PENDING' | 'HELD' | 'REFUNDED' | 'FORFEITED' | null } | null,
  };
}
