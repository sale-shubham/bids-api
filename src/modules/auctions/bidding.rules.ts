import { AppError } from '@/core/errors/AppError';
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
};

export type Bidder = { id: string; isActive: boolean };

/** Lowest acceptable next bid: the starting bid first, then current + increment. */
export function minBidPaise(
  a: Pick<BidAuction, 'bidCount' | 'startingBidPaise' | 'currentBidPaise'>,
  minIncrementPaise: number,
): number {
  return a.bidCount === 0 ? a.startingBidPaise : a.currentBidPaise + minIncrementPaise;
}

/**
 * Throws the AppError the API contract names, in this order: suspended,
 * not found (cancelled/deleted), not started, ended, own auction, already
 * highest, too low. Time checks use startTime/endTime, never the stored status
 * (the close job lags), except a stored ENDED/CANCELLED which is final.
 */
export function validateBid(input: {
  auction: BidAuction;
  bidder: Bidder;
  amountPaise: number;
  now: Date;
  minIncrementPaise: number;
}): { minBidPaise: number } {
  const { auction, bidder, amountPaise, now, minIncrementPaise } = input;
  if (!bidder.isActive) throw new AppError(403, 'ACCOUNT_SUSPENDED', 'Your account has been suspended. Contact admin support.');
  if (auction.status === 'CANCELLED' || auction.deletedAt) throw new AppError(404, 'AUCTION_NOT_FOUND', 'Auction not found');
  if (now.getTime() < auction.startTime.getTime()) throw new AppError(409, 'AUCTION_NOT_STARTED', 'This auction has not started yet');
  if (auction.status === 'ENDED' || now.getTime() >= auction.endTime.getTime()) {
    throw new AppError(409, 'AUCTION_ENDED', 'This auction has ended');
  }
  if (auction.sellerId === bidder.id) throw new AppError(403, 'OWN_AUCTION', 'You cannot bid on your own auction');
  if (auction.highestBidderId === bidder.id) throw new AppError(409, 'ALREADY_HIGHEST', 'You are already the highest bidder');
  const min = minBidPaise(auction, minIncrementPaise);
  if (amountPaise < min) {
    throw new AppError(400, 'BID_TOO_LOW', 'Your bid is too low', { minBidPaise: min });
  }
  return { minBidPaise: min };
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

export type BidRow = { id: string; amountPaise: number; createdAt: Date; bidder: { id: string; name: string } };
export type BidDTO = { id: string; amountPaise: number; createdAt: string; bidderLabel: string; isMe: boolean };

export function toBidDTO(b: BidRow, viewerId?: string | null): BidDTO {
  return {
    id: b.id,
    amountPaise: b.amountPaise,
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
  },
  memberId: string,
  now: Date,
): BidState | null {
  const eff: EffectiveStatus = effectiveStatus(a, now);
  if (eff === 'LIVE') return a.highestBidderId === memberId ? 'WINNING' : 'OUTBID';
  if (eff === 'ENDED') {
    // The close job may not have stamped winnerId yet — the highest bidder is the winner.
    const winner = a.winnerId ?? a.highestBidderId;
    return winner === memberId ? 'WON' : 'LOST';
  }
  return null;
}

export const stateForTab = (tab: BidTab): BidState => tab.toUpperCase() as BidState;
