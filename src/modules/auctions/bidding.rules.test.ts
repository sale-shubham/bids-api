import { describe, expect, it } from 'vitest';
import {
  antiSnipedEndTime,
  bidState,
  bidderLabel,
  commissionAmountPaise,
  stateForTab,
  toBidDTO,
  validateBid,
  type BidAuction,
} from './bidding.rules';

const H = 3600_000;
const now = new Date('2026-11-14T10:00:00Z');
const at = (ms: number) => new Date(now.getTime() + ms);

const auction: BidAuction = {
  status: 'LIVE',
  deletedAt: null,
  startTime: at(-H),
  endTime: at(H),
  sellerId: 'seller',
  highestBidderId: null,
  bidCount: 0,
  startingBidPaise: 100_000,
  currentBidPaise: 0,
};
const bidder = { id: 'bidder', isActive: true };
const run = (over: Partial<BidAuction> = {}, amountPaise = 100_000, b = bidder) =>
  validateBid({ auction: { ...auction, ...over }, bidder: b, amountPaise, now, minIncrementPaise: 10_000 });
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code: string }).code;
  }
  return null;
};

describe('validateBid', () => {
  it('accepts the starting bid as first bid, rejects below it with minBidPaise', () => {
    expect(run({}, 100_000).minBidPaise).toBe(100_000);
    try {
      run({}, 99_999);
      expect.unreachable();
    } catch (e) {
      const err = e as { statusCode: number; code: string; details: unknown };
      expect([err.statusCode, err.code, err.details]).toEqual([400, 'BID_TOO_LOW', { minBidPaise: 100_000 }]);
    }
  });
  it('later bids need current + increment', () => {
    const later = { bidCount: 2, currentBidPaise: 150_000, highestBidderId: 'other' };
    expect(code(() => run(later, 159_999))).toBe('BID_TOO_LOW');
    expect(run(later, 160_000).minBidPaise).toBe(160_000);
  });
  it('uses times, not stored status', () => {
    expect(code(() => run({ status: 'SCHEDULED', startTime: at(1) }))).toBe('AUCTION_NOT_STARTED');
    expect(run({ status: 'SCHEDULED' }).minBidPaise).toBe(100_000); // stored SCHEDULED but already started
    expect(code(() => run({ status: 'LIVE', endTime: now }))).toBe('AUCTION_ENDED'); // end is exclusive
    expect(code(() => run({ status: 'ENDED' }))).toBe('AUCTION_ENDED');
  });
  it('cancelled / deleted -> AUCTION_NOT_FOUND', () => {
    expect(code(() => run({ status: 'CANCELLED' }))).toBe('AUCTION_NOT_FOUND');
    expect(code(() => run({ deletedAt: now }))).toBe('AUCTION_NOT_FOUND');
  });
  it('seller cannot bid; current highest cannot bid again', () => {
    expect(code(() => run({}, 100_000, { id: 'seller', isActive: true }))).toBe('OWN_AUCTION');
    expect(code(() => run({ highestBidderId: 'bidder', bidCount: 1, currentBidPaise: 100_000 }, 500_000))).toBe('ALREADY_HIGHEST');
  });
  it('inactive bidder -> ACCOUNT_SUSPENDED', () => {
    expect(code(() => run({}, 100_000, { id: 'bidder', isActive: false }))).toBe('ACCOUNT_SUSPENDED');
  });
});

describe('antiSnipedEndTime', () => {
  const end = at(60_000); // 1 min left
  it('extends to now + N when inside the window', () => {
    expect(antiSnipedEndTime(end, now, 2).getTime()).toBe(now.getTime() + 2 * 60_000);
  });
  it('leaves the end alone outside the window, at exactly N, or when off', () => {
    expect(antiSnipedEndTime(at(5 * 60_000), now, 2).getTime()).toBe(at(5 * 60_000).getTime());
    expect(antiSnipedEndTime(at(2 * 60_000), now, 2).getTime()).toBe(at(2 * 60_000).getTime());
    expect(antiSnipedEndTime(end, now, 0)).toBe(end);
  });
});

describe('commissionAmountPaise', () => {
  it('rounds to the nearest paisa', () => {
    expect(commissionAmountPaise(100_000, 500)).toBe(5_000);
    expect(commissionAmountPaise(12_345, 500)).toBe(617); // 617.25
    expect(commissionAmountPaise(12_350, 500)).toBe(618); // 617.5 -> 618
    expect(commissionAmountPaise(0, 500)).toBe(0);
  });
});

describe('bidderLabel / toBidDTO', () => {
  it('masks the middle', () => {
    expect(bidderLabel('Ramesh')).toBe('R***h');
    expect(bidderLabel('Raj')).toBe('R***j');
    expect(bidderLabel('Al')).toBe('A***');
    expect(bidderLabel('A')).toBe('A***');
    expect(bidderLabel('  ')).toBe('***');
  });
  it('flags isMe only for the requester', () => {
    const row = { id: 'b1', amountPaise: 5, createdAt: now, bidder: { id: 'm1', name: 'Ramesh' } };
    expect(toBidDTO(row, 'm1')).toEqual({ id: 'b1', amountPaise: 5, createdAt: now.toISOString(), bidderLabel: 'R***h', isMe: true });
    expect(toBidDTO(row, 'm2').isMe).toBe(false);
    expect(toBidDTO(row, null).isMe).toBe(false);
  });
});

describe('bidState / tabs', () => {
  const base = { status: 'LIVE' as const, deletedAt: null, startTime: at(-H), endTime: at(H), highestBidderId: 'me', winnerId: null };
  it('live: winning vs outbid', () => {
    expect(bidState(base, 'me', now)).toBe('WINNING');
    expect(bidState({ ...base, highestBidderId: 'x' }, 'me', now)).toBe('OUTBID');
  });
  it('ended: won vs lost, falling back to highestBidderId before the close job stamps winnerId', () => {
    const ended = { ...base, endTime: at(-1) };
    expect(bidState(ended, 'me', now)).toBe('WON');
    expect(bidState({ ...ended, status: 'ENDED', winnerId: 'x' }, 'me', now)).toBe('LOST');
    expect(bidState({ ...ended, status: 'ENDED', winnerId: 'me', highestBidderId: 'me' }, 'me', now)).toBe('WON');
  });
  it('cancelled has no state; tab maps to state', () => {
    expect(bidState({ ...base, status: 'CANCELLED' }, 'me', now)).toBeNull();
    expect(stateForTab('outbid')).toBe('OUTBID');
    expect(stateForTab('won')).toBe('WON');
  });
});
