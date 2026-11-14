import type { Prisma } from '@prisma/client';

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

export const sellerSelect = { id: true, name: true, avatarUrl: true } as const;
export const auctionInclude = { seller: { select: sellerSelect } } as const;
export type AuctionRow = Prisma.AuctionGetPayload<{ include: typeof auctionInclude }>;

export function toCard(a: AuctionRow, now: Date = new Date()) {
  return {
    id: a.id,
    title: a.title,
    category: a.category,
    condition: a.condition,
    coverImage: a.images[0] ?? null,
    startingBidPaise: a.startingBidPaise,
    currentBidPaise: a.currentBidPaise,
    bidCount: a.bidCount,
    startTime: a.startTime.toISOString(),
    endTime: a.endTime.toISOString(),
    status: effectiveStatus(a, now),
    seller: { id: a.seller.id, name: a.seller.name, avatarUrl: a.seller.avatarUrl },
  };
}

export function toDetail(a: AuctionRow, now: Date = new Date()) {
  return {
    ...toCard(a, now),
    description: a.description,
    images: a.images,
    minIncrementPaise: a.minIncrementPaise,
    highestBidderId: a.highestBidderId,
    winnerId: a.winnerId,
    endedAt: a.endedAt ? a.endedAt.toISOString() : null,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}
