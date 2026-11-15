import { toPaise } from '@/core/money';

// Pure second-chance rules and DTO - no I/O, unit-tested.

export const OFFER_TTL_MS = 48 * 60 * 60 * 1000;

export type OfferStatusValue = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED';

export type Candidate = { bidderId: string; amountPaise: number };

/**
 * The runner-up: per bidder their max bid (fallback: their highest bid row), then the highest of those.
 * The caller already excluded the cancelled buyer(s) and inactive members.
 */
export function pickRunnerUp(
  maxBids: { bidderId: string; maxAmountPaise: number }[],
  bidRows: { bidderId: string; amountPaise: number }[],
): Candidate | null {
  const best = new Map<string, number>();
  for (const m of maxBids) best.set(m.bidderId, m.maxAmountPaise);
  for (const b of bidRows) if (!best.has(b.bidderId)) best.set(b.bidderId, b.amountPaise);
  let top: Candidate | null = null;
  for (const [bidderId, amountPaise] of best) {
    if (!top || amountPaise > top.amountPaise || (amountPaise === top.amountPaise && bidderId < top.bidderId)) top = { bidderId, amountPaise };
  }
  return top;
}

type OfferRow = {
  id: string;
  auctionId: string;
  amountPaise: bigint | number;
  status: OfferStatusValue;
  expiresAt: Date;
  respondedAt: Date | null;
  newSaleId: string | null;
  createdAt: Date;
};
type OfferAuction = { id: string; title: string; images: string[] };

/** A PENDING offer past its expiry is shown as EXPIRED even before the job flips it. */
export function offerStatus(o: { status: OfferStatusValue; expiresAt: Date }, now: Date): OfferStatusValue {
  return o.status === 'PENDING' && o.expiresAt.getTime() <= now.getTime() ? 'EXPIRED' : o.status;
}

export function toOfferDTO(o: OfferRow, a: OfferAuction, now = new Date()) {
  return {
    id: o.id,
    auctionId: o.auctionId,
    auction: { id: a.id, title: a.title, coverImage: a.images[0] ?? null },
    amountPaise: toPaise(o.amountPaise),
    status: offerStatus(o, now),
    expiresAt: o.expiresAt,
    respondedAt: o.respondedAt,
    newSaleId: o.newSaleId,
    createdAt: o.createdAt,
  };
}
export type OfferDTO = ReturnType<typeof toOfferDTO>;
