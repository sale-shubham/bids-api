import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  session: { findMany: vi.fn() },
  member: { findUnique: vi.fn(), findMany: vi.fn() },
  bid: { count: vi.fn(), findMany: vi.fn() },
  shillSignal: { findUnique: vi.fn(), upsert: vi.fn() },
}));
const enqueue = vi.hoisted(() => vi.fn(async (_m: unknown) => undefined));
vi.mock('@/core/prisma/client', () => ({ prisma: db }));
vi.mock('@/core/logger/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/notify/notify.queue', () => ({ enqueueNotification: enqueue }));

import { DAY_MS, mergeSignal, scanBids, scoreBidRisk, type ScanBid } from './risk.rules';
import { checkBidRisk } from './risk.service';
import { runRiskScan } from './risk.jobs';

const now = new Date('2026-11-15T10:00:00Z');
const OLD = 400 * DAY_MS;

describe('scoreBidRisk', () => {
  const base = { sharedDevice: false, sharedIp: false, accountAgeMs: OLD, bidsTotal: 3, bidsOnSeller: 1 };
  it('SHARED_DEVICE alone is 50', () => {
    expect(scoreBidRisk({ ...base, sharedDevice: true })).toEqual({ score: 50, reasons: ['SHARED_DEVICE'] });
  });
  it('SHARED_IP alone is 30 (below the threshold)', () => {
    expect(scoreBidRisk({ ...base, sharedIp: true })).toEqual({ score: 30, reasons: ['SHARED_IP'] });
  });
  it('NEW_ACCOUNT_SINGLE_SELLER needs an account under 7 days old with every bid on this seller', () => {
    expect(scoreBidRisk({ ...base, accountAgeMs: 2 * DAY_MS, bidsTotal: 2, bidsOnSeller: 2 })).toEqual({ score: 20, reasons: ['NEW_ACCOUNT_SINGLE_SELLER'] });
    expect(scoreBidRisk({ ...base, accountAgeMs: 2 * DAY_MS, bidsTotal: 2, bidsOnSeller: 1 }).score).toBe(0);
    expect(scoreBidRisk({ ...base, accountAgeMs: 8 * DAY_MS, bidsTotal: 2, bidsOnSeller: 2 }).score).toBe(0);
  });
  it('adds up', () => {
    expect(scoreBidRisk({ sharedDevice: true, sharedIp: true, accountAgeMs: DAY_MS, bidsTotal: 1, bidsOnSeller: 1 }).score).toBe(100);
  });
});

describe('mergeSignal', () => {
  it('keeps the max score and unions the reasons', () => {
    expect(mergeSignal({ score: 70, reasons: ['SHARED_DEVICE', 'SHARED_IP'] }, { score: 50, reasons: ['SHARED_DEVICE'] })).toEqual({
      score: 70,
      reasons: ['SHARED_DEVICE', 'SHARED_IP'],
    });
    expect(mergeSignal({ score: 50, reasons: ['SHARED_DEVICE'] }, { score: 80, reasons: ['SHARED_IP', 'NEW_ACCOUNT_SINGLE_SELLER'] })).toEqual({
      score: 80,
      reasons: ['SHARED_DEVICE', 'SHARED_IP', 'NEW_ACCOUNT_SINGLE_SELLER'],
    });
    expect(mergeSignal(null, { score: 50, reasons: ['SHARED_DEVICE'] })).toEqual({ score: 50, reasons: ['SHARED_DEVICE'] });
  });
});

describe('checkBidRisk', () => {
  const input = { auctionId: 'a1', bidderId: 'b1', sellerId: 's1' };
  const sessions = (bidder: unknown[], seller: unknown[]) =>
    db.session.findMany.mockImplementation(async ({ where }: { where: { memberId: string } }) => (where.memberId === 'b1' ? bidder : seller));

  beforeEach(() => {
    vi.resetAllMocks();
    db.member.findUnique.mockResolvedValue({ createdAt: new Date(now.getTime() - OLD) });
    db.member.findMany.mockResolvedValue([{ id: 'admin1' }, { id: 'admin2' }]);
    db.bid.count.mockResolvedValue(4);
    db.shillSignal.findUnique.mockResolvedValue(null);
    sessions([{ deviceId: 'd-b', ip: '1.1.1.1' }], [{ deviceId: 'd-s', ip: '2.2.2.2' }]);
  });

  it('a clean bidder is not flagged', async () => {
    const res = await checkBidRisk(input, now);
    expect(res).toMatchObject({ score: 0, flagged: false });
    expect(db.shillSignal.upsert).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('reads sessions of the last 30 days by lastUsedAt', async () => {
    await checkBidRisk(input, now);
    expect(db.session.findMany.mock.calls[0][0].where).toEqual({ memberId: 'b1', lastUsedAt: { gte: new Date(now.getTime() - 30 * DAY_MS) } });
  });

  it('a shared device (+50) flags, stores the signal and notifies every SUPER_ADMIN once each', async () => {
    sessions([{ deviceId: 'dX', ip: null }], [{ deviceId: 'dX', ip: null }]);
    const res = await checkBidRisk(input, now);
    expect(res).toMatchObject({ score: 50, reasons: ['SHARED_DEVICE'], flagged: true });
    expect(db.shillSignal.upsert).toHaveBeenCalledWith({
      where: { auctionId_bidderId: { auctionId: 'a1', bidderId: 'b1' } },
      create: { auctionId: 'a1', bidderId: 'b1', sellerId: 's1', score: 50, reasons: ['SHARED_DEVICE'] },
      update: { score: 50, reasons: ['SHARED_DEVICE'] },
    });
    expect(enqueue.mock.calls.map((c) => (c[0] as { dedupeKey: string }).dedupeKey)).toEqual(['shill-flag:a1:b1:admin1', 'shill-flag:a1:b1:admin2']);
    expect(enqueue.mock.calls[0][0]).toMatchObject({ type: 'shill-flag', memberId: 'admin1', auctionId: 'a1' });
  });

  it('a shared ip alone (+30) stays below the threshold; ip + new single-seller account (+50) flags', async () => {
    sessions([{ deviceId: 'd-b', ip: '9.9.9.9' }], [{ deviceId: 'd-s', ip: '9.9.9.9' }]);
    expect(await checkBidRisk(input, now)).toMatchObject({ score: 30, reasons: ['SHARED_IP'], flagged: false });
    db.member.findUnique.mockResolvedValue({ createdAt: new Date(now.getTime() - 2 * DAY_MS) });
    db.bid.count.mockResolvedValue(3); // every bid is on this seller
    expect(await checkBidRisk(input, now)).toMatchObject({ score: 50, reasons: ['SHARED_IP', 'NEW_ACCOUNT_SINGLE_SELLER'], flagged: true });
  });

  it('a null ip never matches a null ip', async () => {
    sessions([{ deviceId: 'd-b', ip: null }], [{ deviceId: 'd-s', ip: null }]);
    expect((await checkBidRisk(input, now)).score).toBe(0);
  });

  it('merges into an existing signal: max score, union of reasons', async () => {
    db.shillSignal.findUnique.mockResolvedValue({ score: 80, reasons: ['SHARED_IP', 'SHARED_DEVICE'] });
    sessions([{ deviceId: 'dX', ip: null }], [{ deviceId: 'dX', ip: null }]);
    await checkBidRisk(input, now);
    expect(db.shillSignal.upsert.mock.calls[0][0].update).toEqual({ score: 80, reasons: ['SHARED_IP', 'SHARED_DEVICE'] });
  });

  it('never throws out of the signal step (a DB failure is swallowed)', async () => {
    sessions([{ deviceId: 'dX', ip: null }], [{ deviceId: 'dX', ip: null }]);
    db.shillSignal.upsert.mockRejectedValue(new Error('db down'));
    expect(await checkBidRisk(input, now)).toMatchObject({ score: 50, flagged: false });
  });
});

describe('scanBids', () => {
  const bid = (over: Partial<ScanBid> = {}): ScanBid => ({
    bidderId: 'b1',
    auctionId: 'a1',
    sellerId: 's1',
    auctionEnded: true,
    winnerId: 'someone',
    auctionEndTime: new Date('2026-11-01T00:00:00Z'),
    ...over,
  });
  const onSeller = (seller: string, n: number, ended = true) =>
    Array.from({ length: n }, (_, i) => bid({ sellerId: seller, auctionId: `${seller}-a${i % 3}`, auctionEnded: ended, auctionEndTime: new Date(2026, 9, 1 + (i % 3)) }));

  it('CONCENTRATION (+40) and NEVER_WINS (+30) together flag at 70', () => {
    const out = scanBids(onSeller('s1', 6));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ bidderId: 'b1', sellerId: 's1', score: 70, reasons: ['CONCENTRATION', 'NEVER_WINS'] });
  });

  it('CONCENTRATION needs >= 5 bids and more than 70% on one seller', () => {
    // 4 bids on s1 only: no concentration, and only 3 ended auctions for NEVER_WINS (30 < 50)
    expect(scanBids(onSeller('s1', 4))).toEqual([]);
    // 7 of 10 is exactly 70%: not more than 70%
    expect(scanBids([...onSeller('s1', 7, false), ...onSeller('s2', 3, false)])).toEqual([]);
  });

  it('NEVER_WINS needs >= 3 of the seller ended auctions, all lost', () => {
    const lost = scanBids(onSeller('s1', 6));
    expect(lost[0].reasons).toContain('NEVER_WINS');
    // one win breaks it: concentration alone is 40, below the threshold
    const won = onSeller('s1', 6).map((b) => (b.auctionId === 's1-a0' ? { ...b, winnerId: 'b1' } : b));
    expect(scanBids(won)).toEqual([]);
    // live auctions do not count as ended
    expect(scanBids(onSeller('s1', 6, false))).toEqual([]);
  });

  it("signals the seller's latest auction the bidder bid on", () => {
    const rows = onSeller('s1', 6).map((b, i) => ({ ...b, auctionEndTime: new Date(2026, 9, 1 + (i % 3)) }));
    const out = scanBids(rows);
    expect(out[0].auctionId).toBe('s1-a2');
  });

  it('a spread-out bidder is never flagged', () => {
    const rows = ['s1', 's2', 's3', 's4', 's5'].flatMap((s) => onSeller(s, 2));
    expect(scanBids(rows)).toEqual([]);
  });
});

describe('runRiskScan', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    db.shillSignal.findUnique.mockResolvedValue(null);
    db.member.findMany.mockResolvedValue([{ id: 'admin1' }]);
  });
  it('scans the last 90 days, upserts a signal per flagged pair and notifies', async () => {
    const row = (i: number) => ({
      bidderId: 'b1',
      auctionId: `a${i % 3}`,
      auction: { sellerId: 's1', status: 'ENDED', winnerId: 'x', endTime: new Date(2026, 9, 1 + (i % 3)) },
    });
    db.bid.findMany.mockResolvedValue(Array.from({ length: 6 }, (_, i) => row(i)));
    const res = await runRiskScan(now);
    expect(res).toEqual({ scanned: 6, flagged: 1 });
    expect(db.bid.findMany.mock.calls[0][0].where).toEqual({ createdAt: { gte: new Date(now.getTime() - 90 * DAY_MS) } });
    expect(db.shillSignal.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { auctionId_bidderId: { auctionId: 'a2', bidderId: 'b1' } },
        create: expect.objectContaining({ sellerId: 's1', score: 70, reasons: ['CONCENTRATION', 'NEVER_WINS'] }),
      }),
    );
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ type: 'shill-flag', memberId: 'admin1', dedupeKey: 'shill-flag:a2:b1:admin1' }));
  });
  it('flags nothing for a normal history', async () => {
    db.bid.findMany.mockResolvedValue([]);
    expect(await runRiskScan(now)).toEqual({ scanned: 0, flagged: 0 });
    expect(db.shillSignal.upsert).not.toHaveBeenCalled();
  });
});
