import { AppError } from '@/core/errors/AppError';
import { toPaise } from '@/core/money';
import { effectiveStatus, type EffectiveStatus } from './auctions.serializer';

// Pure bidding / closing rules — no I/O, unit-tested. The transaction in
// bids.service.ts feeds them rows read under the auction's row lock.

export const COMMISSION_DUE_DAYS = 7;

export type BidAuction = {
  status: 'SCHEDULED' | 'LIVE' | 'ENDED' | 'CANCELLED';
  deletedAt: Date | null;
  startTime: Date;
  endTime: Date;
  sellerId: string;
  highestBidderId: string | null;
  bidCount: number;
  startingBidPaise: number;
  currentBidPaise: number;
  reservePricePaise: number | null;
  buyNowPricePaise: number | null;
};

export type BidKindValue = 'MANUAL' | 'AUTO' | 'BUY_NOW';

export type Bidder = { id: string; isActive: boolean };

/** Lowest acceptable next bid: the starting bid first, then current + increment. */
export function minBidPaise(
  a: Pick<BidAuction, 'bidCount' | 'startingBidPaise' | 'currentBidPaise'>,
  minIncrementPaise: number,
): number {
  return a.bidCount === 0 ? a.startingBidPaise : a.currentBidPaise + minIncrementPaise;
}

/** Reserve is met when there is none, or a bid has reached it. Never shown to bidders, only this boolean. */
export function reserveMet(a: { reservePricePaise: number | null; bidCount: number; currentBidPaise: number }): boolean {
  if (a.reservePricePaise === null) return true;
  return a.bidCount > 0 && a.currentBidPaise >= a.reservePricePaise;
}

/** The close job stamps winnerId; until it runs the highest bidder wins, but only when the reserve is met. */
export function provisionalWinnerId(a: {
  winnerId: string | null;
  highestBidderId: string | null;
  reservePricePaise: number | null;
  bidCount: number;
  currentBidPaise: number;
}): string | null {
  return a.winnerId ?? (a.bidCount > 0 && reserveMet(a) ? a.highestBidderId : null);
}

type PreCheckInput = { auction: BidAuction; bidder: Bidder; now: Date };

function preChecks({ auction, bidder, now }: PreCheckInput): void {
  if (!bidder.isActive) throw new AppError(403, 'ACCOUNT_SUSPENDED', 'Your account has been suspended. Contact admin support.');
  if (auction.status === 'CANCELLED' || auction.deletedAt) throw new AppError(404, 'AUCTION_NOT_FOUND', 'Auction not found');
  if (now.getTime() < auction.startTime.getTime()) throw new AppError(409, 'AUCTION_NOT_STARTED', 'This auction has not started yet');
  if (auction.status === 'ENDED' || now.getTime() >= auction.endTime.getTime()) {
    throw new AppError(409, 'AUCTION_ENDED', 'This auction has ended');
  }
  if (auction.sellerId === bidder.id) throw new AppError(403, 'OWN_AUCTION', 'You cannot bid on your own auction');
}

/**
 * Throws the AppError the API contract names, in this order: suspended,
 * not found (cancelled/deleted), not started, ended, own auction. The amount is
 * judged by resolveMaxBid. Time checks use startTime/endTime, never the stored
 * status (the close job lags), except a stored ENDED/CANCELLED which is final.
 */
export function validateBid(input: PreCheckInput): void {
  preChecks(input);
}

/** Same pre-checks as a bid, then Buy It Now must still be on offer (set and no bids yet). */
export function validateBuyNow(input: PreCheckInput): void {
  preChecks(input);
  if (input.auction.buyNowPricePaise === null || input.auction.bidCount > 0) {
    throw new AppError(409, 'BUY_NOW_UNAVAILABLE', 'Buy It Now is no longer available');
  }
}

export type ResolvedRow = { bidderId: string; amountPaise: number; kind: 'MANUAL' | 'AUTO' };
export type ResolvedBid = {
  rows: ResolvedRow[];
  highestBidderId: string;
  currentBidPaise: number;
  outbidByProxy: boolean;
};

/**
 * Max-bid (eBay-style) resolution; every bid is a maximum. Pure: the caller
 * feeds the locked auction row and the leader's stored max, then writes `rows`
 * in order. See readme/flows/bidding.md for the rules.
 */
export function resolveMaxBid(input: {
  auction: Pick<BidAuction, 'bidCount' | 'startingBidPaise' | 'currentBidPaise' | 'highestBidderId' | 'reservePricePaise'>;
  minIncrementPaise: number;
  leaderMaxPaise: number | null;
  bidderId: string;
  maxPaise: number;
}): ResolvedBid {
  const { auction, minIncrementPaise: inc, bidderId, maxPaise } = input;
  const reserve = auction.reservePricePaise;
  const cur = auction.currentBidPaise;
  const rows: ResolvedRow[] = [];
  const tooLow = (min: number) => new AppError(400, 'BID_TOO_LOW', 'Your bid is too low', { minBidPaise: min });

  // Raises the final price to the reserve when the winning max reaches it.
  const reserveJump = (winnerMax: number, price: number): number =>
    reserve !== null && winnerMax >= reserve && price < reserve ? reserve : price;

  // 2. First bid.
  if (auction.bidCount === 0 || !auction.highestBidderId) {
    if (maxPaise < auction.startingBidPaise) throw tooLow(auction.startingBidPaise);
    const price = reserveJump(maxPaise, auction.startingBidPaise);
    rows.push({ bidderId, amountPaise: price, kind: 'MANUAL' });
    return { rows, highestBidderId: bidderId, currentBidPaise: price, outbidByProxy: false };
  }

  const leaderId = auction.highestBidderId;
  const leaderMax = Math.max(input.leaderMaxPaise ?? cur, cur);

  // 3. The leader raises their own maximum: no row, except a jump to the reserve.
  if (leaderId === bidderId) {
    if (maxPaise <= leaderMax) {
      throw new AppError(400, 'MAX_TOO_LOW', 'Your new maximum must be higher than your current maximum', {
        currentMaxPaise: leaderMax,
      });
    }
    const price = reserveJump(maxPaise, cur);
    if (price !== cur) rows.push({ bidderId, amountPaise: price, kind: 'AUTO' });
    return { rows, highestBidderId: bidderId, currentBidPaise: price, outbidByProxy: false };
  }

  // 4. / 5. Challenger.
  const minBid = cur + inc;
  if (maxPaise < minBid) throw tooLow(minBid);

  if (maxPaise > leaderMax) {
    if (leaderMax > cur) rows.push({ bidderId: leaderId, amountPaise: leaderMax, kind: 'AUTO' });
    rows.push({ bidderId, amountPaise: Math.min(maxPaise, leaderMax + inc), kind: 'MANUAL' });
    const last = rows[rows.length - 1]!;
    last.amountPaise = reserveJump(maxPaise, last.amountPaise);
    return { rows, highestBidderId: bidderId, currentBidPaise: last.amountPaise, outbidByProxy: false };
  }

  rows.push({ bidderId, amountPaise: maxPaise, kind: 'MANUAL' });
  rows.push({ bidderId: leaderId, amountPaise: Math.min(leaderMax, maxPaise + inc), kind: 'AUTO' });
  const last = rows[rows.length - 1]!;
  last.amountPaise = reserveJump(leaderMax, last.amountPaise);
  return { rows, highestBidderId: leaderId, currentBidPaise: last.amountPaise, outbidByProxy: true };
}

/** Anti-sniping: a bid inside the last `minutes` pushes the end to now + minutes. 0 = off. */
export function antiSnipedEndTime(endTime: Date, now: Date, minutes: number): Date {
  if (!(minutes > 0)) return endTime;
  const windowMs = minutes * 60_000;
  return endTime.getTime() - now.getTime() < windowMs ? new Date(now.getTime() + windowMs) : endTime;
}

/** "R***h" — first char + *** + last char; 1-2 char names -> first char + ***. */
export function bidderLabel(name: string): string {
  const chars = Array.from(name.trim());
  if (chars.length === 0) return '***';
  if (chars.length <= 2) return `${chars[0]}***`;
  return `${chars[0]}***${chars[chars.length - 1]}`;
}

export type BidRow = {
  id: string;
  amountPaise: bigint | number;
  kind: BidKindValue;
  createdAt: Date;
  bidder: { id: string; name: string };
};
export type BidDTO = {
  id: string;
  amountPaise: number;
  kind: BidKindValue;
  createdAt: string;
  bidderLabel: string;
  isMe: boolean;
};

export function toBidDTO(b: BidRow, viewerId?: string | null): BidDTO {
  return {
    id: b.id,
    amountPaise: toPaise(b.amountPaise),
    kind: b.kind,
    createdAt: b.createdAt.toISOString(),
    bidderLabel: bidderLabel(b.bidder.name),
    isMe: !!viewerId && b.bidder.id === viewerId,
  };
}

/** Platform commission, rounded to the nearest paisa. */
export function commissionAmountPaise(finalBidPaise: number, rateBps: number): number {
  return Math.round((finalBidPaise * rateBps) / 10_000);
}

export type BidState = 'WINNING' | 'OUTBID' | 'WON' | 'LOST';
export const BID_TABS = ['winning', 'outbid', 'won', 'lost'] as const;
export type BidTab = (typeof BID_TABS)[number];

/** State of a member's bid on an auction, or null (cancelled / not biddable yet). */
export function bidState(
  a: {
    status: BidAuction['status'];
    deletedAt: Date | null;
    startTime: Date;
    endTime: Date;
    highestBidderId: string | null;
    winnerId: string | null;
    bidCount: number;
    currentBidPaise: number;
    reservePricePaise: number | null;
  },
  memberId: string,
  now: Date,
): BidState | null {
  const eff: EffectiveStatus = effectiveStatus(a, now);
  if (eff === 'LIVE') return a.highestBidderId === memberId ? 'WINNING' : 'OUTBID';
  if (eff === 'ENDED') {
    // The close job may not have stamped winnerId yet; below the reserve nobody wins.
    return provisionalWinnerId(a) === memberId ? 'WON' : 'LOST';
  }
  return null;
}

export const stateForTab = (tab: BidTab): BidState => tab.toUpperCase() as BidState;
