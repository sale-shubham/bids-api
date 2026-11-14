import type { Prisma } from '@prisma/client';
import type { ListQuery } from './auctions.validation';

type Where = Prisma.AuctionWhereInput;

// Time-based status filters (never trust stored status alone; see serializer).
export function statusWhere(status: 'live' | 'upcoming' | 'ended' | 'cancelled', now: Date): Where {
  const notFinal: Where = { deletedAt: null, status: { notIn: ['CANCELLED', 'ENDED'] } };
  switch (status) {
    case 'live':
      return { ...notFinal, startTime: { lte: now }, endTime: { gt: now } };
    case 'upcoming':
      return { ...notFinal, startTime: { gt: now } };
    case 'ended':
      return { deletedAt: null, status: { not: 'CANCELLED' }, OR: [{ status: 'ENDED' }, { endTime: { lte: now } }] };
    case 'cancelled':
      return { OR: [{ status: 'CANCELLED' }, { deletedAt: { not: null } }] };
  }
}

/**
 * Price = currentBid when there are bids, else startingBid (what
 * GREATEST(currentBidPaise, startingBidPaise) yields, since a bid is always
 * >= the starting bid). Returns undefined when no bound is given.
 */
export function priceFilter(minPrice?: number, maxPrice?: number): Where | undefined {
  if (minPrice === undefined && maxPrice === undefined) return undefined;
  const range = {
    ...(minPrice !== undefined ? { gte: minPrice } : {}),
    ...(maxPrice !== undefined ? { lte: maxPrice } : {}),
  };
  return { OR: [{ bidCount: 0, startingBidPaise: range }, { bidCount: { gt: 0 }, currentBidPaise: range }] };
}

export function listWhere(q: ListQuery, now: Date): Where {
  const and: Where[] = [statusWhere(q.status, now)];
  if (q.category) and.push({ category: q.category });
  if (q.sellerId) and.push({ sellerId: q.sellerId });
  if (q.condition) and.push({ condition: q.condition });
  if (q.q) and.push({ title: { contains: q.q, mode: 'insensitive' } });
  const price = priceFilter(q.minPrice, q.maxPrice);
  if (price) and.push(price);
  return { AND: and };
}

/** Effective price used for priceAsc / priceDesc ordering. */
export function effectivePrice(a: { bidCount: number; currentBidPaise: number; startingBidPaise: number }): number {
  return a.bidCount > 0 ? Math.max(a.currentBidPaise, a.startingBidPaise) : a.startingBidPaise;
}

type Order = Prisma.AuctionOrderByWithRelationInput[];

/** Prisma orderBy for non-price sorts. Price sorts are handled in the service. */
export function orderFor(status: ListQuery['status'] | 'cancelled', sort?: ListQuery['sort']): Order {
  const tie = { id: 'asc' as const };
  switch (sort) {
    case 'newest':
      return [{ createdAt: 'desc' }, tie];
    case 'mostBids':
      return [{ bidCount: 'desc' }, { endTime: 'asc' }, tie];
    case 'endingSoon':
    default:
      // ended / cancelled: most recently ended first.
      return status === 'ended' || status === 'cancelled' ? [{ endTime: 'desc' }, tie] : [{ endTime: 'asc' }, tie];
  }
}
