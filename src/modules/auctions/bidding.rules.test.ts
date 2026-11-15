import { describe, expect, it } from 'vitest';
import {
  antiSnipedEndTime,
  bidState,
  bidderLabel,
  commissionAmountPaise,
  provisionalWinnerId,
  reserveMet,
  resolveMaxBid,
  stateForTab,
  toBidDTO,
  validateBid,
  validateBuyNow,
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
  reservePricePaise: null,
  buyNowPricePaise: null,
};
const bidder = { id: 'bidder', isActive: true };
const noDeposit = { requiredPaise: 0, held: false };
const run = (over: Partial<BidAuction> = {}, b = bidder, deposit = noDeposit) =>
  validateBid({ auction: { ...auction, ...over }, bidder: b, now, deposit });
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code: string }).code;
  }
  return null;
};
const err = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    const x = e as { statusCode: number; code: string; details: unknown };
    return [x.statusCode, x.code, x.details];
  }
  return null;
};

describe('validateBid (pre-checks only)', () => {
  it('passes for an open auction', () => {
    expect(() => run()).not.toThrow();
  });
  it('uses times, not stored status', () => {
    expect(code(() => run({ status: 'SCHEDULED', startTime: at(1) }))).toBe('AUCTION_NOT_STARTED');
    expect(() => run({ status: 'SCHEDULED' })).not.toThrow(); // stored SCHEDULED but already started
    expect(code(() => run({ status: 'LIVE', endTime: now }))).toBe('AUCTION_ENDED'); // end is exclusive
    expect(code(() => run({ status: 'ENDED' }))).toBe('AUCTION_ENDED');
  });
  it('cancelled / deleted -> AUCTION_NOT_FOUND', () => {
    expect(code(() => run({ status: 'CANCELLED' }))).toBe('AUCTION_NOT_FOUND');
    expect(code(() => run({ deletedAt: now }))).toBe('AUCTION_NOT_FOUND');
  });
  it('seller cannot bid; the current leader may (raise-max path)', () => {
    expect(code(() => run({}, { id: 'seller', isActive: true }))).toBe('OWN_AUCTION');
    expect(() => run({ highestBidderId: 'bidder', bidCount: 1, currentBidPaise: 100_000 })).not.toThrow();
  });
  it('inactive bidder -> ACCOUNT_SUSPENDED', () => {
    expect(code(() => run({}, { id: 'bidder', isActive: false }))).toBe('ACCOUNT_SUSPENDED');
  });
  it('a required deposit that is not held -> 403 DEPOSIT_REQUIRED with depositPaise', () => {
    expect(err(() => run({}, bidder, { requiredPaise: 1_000_000, held: false }))).toEqual([
      403,
      'DEPOSIT_REQUIRED',
      { depositPaise: 1_000_000 },
    ]);
  });
  it('a held deposit, or none required, passes', () => {
    expect(() => run({}, bidder, { requiredPaise: 1_000_000, held: true })).not.toThrow();
    expect(() => run({}, bidder, { requiredPaise: 0, held: false })).not.toThrow();
  });
  it('the deposit check comes after the other pre-checks', () => {
    const need = { requiredPaise: 5, held: false };
    expect(code(() => run({ status: 'ENDED' }, bidder, need))).toBe('AUCTION_ENDED');
    expect(code(() => run({}, { id: 'seller', isActive: true }, need))).toBe('OWN_AUCTION');
  });
});

describe('validateBuyNow', () => {
  const bn = (over: Partial<BidAuction> = {}, b = bidder, deposit = noDeposit) =>
    validateBuyNow({ auction: { ...auction, buyNowPricePaise: 900_000, ...over }, bidder: b, now, deposit });
  it('accepts when set and there are no bids', () => {
    expect(() => bn()).not.toThrow();
  });
  it('DEPOSIT_REQUIRED applies to Buy It Now too', () => {
    expect(err(() => bn({}, bidder, { requiredPaise: 7_000, held: false }))).toEqual([403, 'DEPOSIT_REQUIRED', { depositPaise: 7_000 }]);
    expect(() => bn({}, bidder, { requiredPaise: 7_000, held: true })).not.toThrow();
  });
  it('BUY_NOW_UNAVAILABLE when unset or after the first bid', () => {
    expect(err(() => bn({ buyNowPricePaise: null }))).toEqual([409, 'BUY_NOW_UNAVAILABLE', undefined]);
    expect(code(() => bn({ bidCount: 1, highestBidderId: 'x', currentBidPaise: 100_000 }))).toBe('BUY_NOW_UNAVAILABLE');
  });
  it('shares the bid pre-checks, in order', () => {
    expect(code(() => bn({ status: 'ENDED' }))).toBe('AUCTION_ENDED');
    expect(code(() => bn({}, { id: 'seller', isActive: true }))).toBe('OWN_AUCTION');
    expect(code(() => bn({}, { id: 'bidder', isActive: false }))).toBe('ACCOUNT_SUSPENDED');
    expect(code(() => bn({ status: 'CANCELLED' }))).toBe('AUCTION_NOT_FOUND');
    expect(code(() => bn({ startTime: at(1) }))).toBe('AUCTION_NOT_STARTED');
  });
});

describe('reserveMet / provisionalWinnerId', () => {
  it('no reserve is always met', () => {
    expect(reserveMet({ reservePricePaise: null, bidCount: 0, currentBidPaise: 0 })).toBe(true);
  });
  it('reserve needs a bid at or above it', () => {
    expect(reserveMet({ reservePricePaise: 500, bidCount: 0, currentBidPaise: 0 })).toBe(false);
    expect(reserveMet({ reservePricePaise: 500, bidCount: 2, currentBidPaise: 499 })).toBe(false);
    expect(reserveMet({ reservePricePaise: 500, bidCount: 2, currentBidPaise: 500 })).toBe(true);
  });
  it('provisional winner: stamped winner, else the leader only when the reserve is met', () => {
    const a = { winnerId: null, highestBidderId: 'h', reservePricePaise: 500, bidCount: 1, currentBidPaise: 400 };
    expect(provisionalWinnerId(a)).toBeNull();
    expect(provisionalWinnerId({ ...a, currentBidPaise: 500 })).toBe('h');
    expect(provisionalWinnerId({ ...a, reservePricePaise: null })).toBe('h');
    expect(provisionalWinnerId({ ...a, bidCount: 0, reservePricePaise: null })).toBeNull();
    expect(provisionalWinnerId({ ...a, winnerId: 'w' })).toBe('w');
  });
});

describe('resolveMaxBid', () => {
  const INC = 10_000;
  const base = { bidCount: 0, startingBidPaise: 100_000, currentBidPaise: 0, highestBidderId: null as string | null, reservePricePaise: null as number | null };
  const live = (over: Partial<typeof base> = {}) => ({ ...base, bidCount: 2, currentBidPaise: 150_000, highestBidderId: 'L', ...over });
  const go = (a: typeof base, maxPaise: number, leaderMaxPaise: number | null = null, bidderId = 'B') =>
    resolveMaxBid({ auction: a, minIncrementPaise: INC, leaderMaxPaise, bidderId, maxPaise });
  const shape = (r: ReturnType<typeof go>) => r.rows.map((x) => [x.bidderId, x.amountPaise, x.kind]);

  type Case = {
    name: string;
    auction: typeof base;
    max: number;
    leaderMax?: number | null;
    bidderId?: string;
    rows: [string, number, string][];
    leader: string;
    price: number;
    byProxy: boolean;
  };
  const cases: Case[] = [
    { name: 'first bid takes the starting bid, not the max', auction: base, max: 500_000, rows: [['B', 100_000, 'MANUAL']], leader: 'B', price: 100_000, byProxy: false },
    { name: 'first bid at exactly the start', auction: base, max: 100_000, rows: [['B', 100_000, 'MANUAL']], leader: 'B', price: 100_000, byProxy: false },
    { name: 'first bid with max >= reserve jumps to the reserve', auction: { ...base, reservePricePaise: 300_000 }, max: 400_000, rows: [['B', 300_000, 'MANUAL']], leader: 'B', price: 300_000, byProxy: false },
    { name: 'first bid with max below reserve stays at start', auction: { ...base, reservePricePaise: 300_000 }, max: 250_000, rows: [['B', 100_000, 'MANUAL']], leader: 'B', price: 100_000, byProxy: false },
    { name: 'beat a leader without a MaxBid row: price = current + inc', auction: live(), max: 500_000, leaderMax: null, rows: [['B', 160_000, 'MANUAL']], leader: 'B', price: 160_000, byProxy: false },
    { name: 'beat a leader with a MaxBid: AUTO row at their max, then MANUAL at max + inc', auction: live(), max: 500_000, leaderMax: 200_000, rows: [['L', 200_000, 'AUTO'], ['B', 210_000, 'MANUAL']], leader: 'B', price: 210_000, byProxy: false },
    { name: 'beat the leader by less than an increment: capped at own max', auction: live(), max: 205_000, leaderMax: 200_000, rows: [['L', 200_000, 'AUTO'], ['B', 205_000, 'MANUAL']], leader: 'B', price: 205_000, byProxy: false },
    { name: 'lose to the leader: MANUAL then AUTO at max + inc, outbidByProxy', auction: live(), max: 180_000, leaderMax: 400_000, rows: [['B', 180_000, 'MANUAL'], ['L', 190_000, 'AUTO']], leader: 'L', price: 190_000, byProxy: true },
    { name: 'lose to the leader whose max is just above', auction: live(), max: 180_000, leaderMax: 185_000, rows: [['B', 180_000, 'MANUAL'], ['L', 185_000, 'AUTO']], leader: 'L', price: 185_000, byProxy: true },
    { name: 'tie goes to the leader', auction: live(), max: 300_000, leaderMax: 300_000, rows: [['B', 300_000, 'MANUAL'], ['L', 300_000, 'AUTO']], leader: 'L', price: 300_000, byProxy: true },
    { name: 'minimum challenger against a bare leader (max == current + inc)', auction: live(), max: 160_000, leaderMax: null, rows: [['B', 160_000, 'MANUAL']], leader: 'B', price: 160_000, byProxy: false },
    { name: 'leader raises max: no rows', auction: live(), max: 400_000, leaderMax: 200_000, bidderId: 'L', rows: [], leader: 'L', price: 150_000, byProxy: false },
    { name: 'leader raise crosses the reserve: AUTO row at the reserve', auction: live({ reservePricePaise: 300_000 }), max: 400_000, leaderMax: 200_000, bidderId: 'L', rows: [['L', 300_000, 'AUTO']], leader: 'L', price: 300_000, byProxy: false },
    { name: 'leader raise below the reserve: no rows', auction: live({ reservePricePaise: 300_000 }), max: 250_000, leaderMax: 200_000, bidderId: 'L', rows: [], leader: 'L', price: 150_000, byProxy: false },
    { name: 'challenger win jumps the last row to the reserve', auction: live({ reservePricePaise: 300_000 }), max: 500_000, leaderMax: 200_000, rows: [['L', 200_000, 'AUTO'], ['B', 300_000, 'MANUAL']], leader: 'B', price: 300_000, byProxy: false },
    { name: 'challenger loses but the leader max reaches the reserve: AUTO row raised to it', auction: live({ reservePricePaise: 300_000 }), max: 180_000, leaderMax: 400_000, rows: [['B', 180_000, 'MANUAL'], ['L', 300_000, 'AUTO']], leader: 'L', price: 300_000, byProxy: true },
    { name: 'reserve above both maxes: no jump', auction: live({ reservePricePaise: 900_000 }), max: 500_000, leaderMax: 200_000, rows: [['L', 200_000, 'AUTO'], ['B', 210_000, 'MANUAL']], leader: 'B', price: 210_000, byProxy: false },
  ];

  it.each(cases)('$name', (c) => {
    const r = go(c.auction, c.max, c.leaderMax ?? null, c.bidderId);
    expect(shape(r)).toEqual(c.rows);
    expect(r.highestBidderId).toBe(c.leader);
    expect(r.currentBidPaise).toBe(c.price);
    expect(r.outbidByProxy).toBe(c.byProxy);
  });

  it('never exceeds a bidder max and amounts never decrease', () => {
    for (const c of cases) {
      const r = go(c.auction, c.max, c.leaderMax ?? null, c.bidderId);
      const maxOf = (id: string) => (id === (c.bidderId ?? 'B') ? c.max : (c.leaderMax ?? c.auction.currentBidPaise));
      let prev = 0;
      for (const row of r.rows) {
        expect(row.amountPaise).toBeLessThanOrEqual(maxOf(row.bidderId));
        expect(row.amountPaise).toBeGreaterThanOrEqual(prev);
        prev = row.amountPaise;
      }
    }
  });

  it('BID_TOO_LOW carries minBidPaise (start for the first bid, current + inc later)', () => {
    expect(err(() => go(base, 99_999))).toEqual([400, 'BID_TOO_LOW', { minBidPaise: 100_000 }]);
    expect(err(() => go(live(), 159_999, 200_000))).toEqual([400, 'BID_TOO_LOW', { minBidPaise: 160_000 }]);
  });

  it('leader: MAX_TOO_LOW unless strictly higher than their max (or current price when no row)', () => {
    expect(err(() => go(live(), 200_000, 200_000, 'L'))).toEqual([400, 'MAX_TOO_LOW', { currentMaxPaise: 200_000 }]);
    expect(err(() => go(live(), 150_000, null, 'L'))).toEqual([400, 'MAX_TOO_LOW', { currentMaxPaise: 150_000 }]);
    expect(go(live(), 150_001, null, 'L').rows).toEqual([]);
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
  it('flags isMe only for the requester and carries kind', () => {
    const row = { id: 'b1', amountPaise: 5, kind: 'AUTO' as const, createdAt: now, bidder: { id: 'm1', name: 'Ramesh' } };
    expect(toBidDTO(row, 'm1')).toEqual({ id: 'b1', amountPaise: 5, kind: 'AUTO', createdAt: now.toISOString(), bidderLabel: 'R***h', isMe: true });
    expect(toBidDTO(row, 'm2').isMe).toBe(false);
    expect(toBidDTO(row, null).isMe).toBe(false);
  });
});

describe('bidState / tabs', () => {
  const base = {
    status: 'LIVE' as const,
    deletedAt: null,
    startTime: at(-H),
    endTime: at(H),
    highestBidderId: 'me',
    winnerId: null,
    bidCount: 1,
    currentBidPaise: 100_000,
    reservePricePaise: null as number | null,
  };
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
  it('ended below the reserve: the highest bidder is LOST, not WON', () => {
    const ended = { ...base, endTime: at(-1), reservePricePaise: 500_000 };
    expect(bidState(ended, 'me', now)).toBe('LOST');
    expect(bidState({ ...ended, status: 'ENDED' }, 'me', now)).toBe('LOST');
    expect(bidState({ ...ended, currentBidPaise: 500_000 }, 'me', now)).toBe('WON');
  });
  it('cancelled has no state; tab maps to state', () => {
    expect(bidState({ ...base, status: 'CANCELLED' }, 'me', now)).toBeNull();
    expect(stateForTab('outbid')).toBe('OUTBID');
    expect(stateForTab('won')).toBe('WON');
  });
});
