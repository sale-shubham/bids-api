import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  auction: { findUnique: vi.fn(), findMany: vi.fn(), aggregate: vi.fn() },
  auctionStatDaily: { groupBy: vi.fn(), findMany: vi.fn() },
  auctionViewer: { deleteMany: vi.fn() },
  watchlist: { groupBy: vi.fn(), count: vi.fn() },
  $executeRaw: vi.fn(),
  $queryRaw: vi.fn(),
}));
vi.mock('@/core/prisma/client', () => ({ prisma: db }));

import { auctionAnalytics, recordView, sellerAnalytics } from './analytics.service';
import { addDays, eachDay, istDay, rangeFor, viewerKeyFor } from './analytics.rules';
import { rangeQuerySchema } from './analytics.validation';
import crypto from 'node:crypto';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const NOW = new Date('2026-11-16T20:00:00Z'); // 2026-11-17 01:30 IST

beforeEach(() => {
  vi.resetAllMocks();
  db.auction.findUnique.mockResolvedValue({ sellerId: 's1', deletedAt: null });
});

describe('viewer key + dates', () => {
  it('prefers member, then device cookie, then ip + user agent', () => {
    expect(viewerKeyFor({ memberId: 'm1', deviceId: 'd1', ip: '1.1.1.1' })).toBe(sha('m:m1'));
    expect(viewerKeyFor({ deviceId: 'd1', ip: '1.1.1.1' })).toBe(sha('d:d1'));
    expect(viewerKeyFor({ ip: '1.1.1.1', userAgent: 'UA' })).toBe(sha('i:1.1.1.1|UA'));
  });
  it('uses Asia/Kolkata days', () => {
    expect(istDay(NOW)).toBe('2026-11-17');
    expect(istDay(new Date('2026-11-16T18:29:59Z'))).toBe('2026-11-16');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    const r = rangeFor(7, NOW);
    expect(r).toMatchObject({ from: '2026-11-11', to: '2026-11-17' });
    expect(r.start.toISOString()).toBe('2026-11-10T18:30:00.000Z');
    expect(r.end.toISOString()).toBe('2026-11-17T18:30:00.000Z');
    expect(eachDay(r.from, r.to)).toHaveLength(7);
  });
  it('days query accepts 7 / 30 / 90 only, default 30', () => {
    expect(rangeQuerySchema.validate({}).value).toEqual({ days: 30 });
    expect(rangeQuerySchema.validate({ days: '90' }).value).toEqual({ days: 90 });
    expect(rangeQuerySchema.validate({ days: 14 }).error).toBeDefined();
  });
});

describe('recordView', () => {
  it('counts a view with one statement carrying the hashed key and the IST date', async () => {
    expect(await recordView('a1', { memberId: 'm1' }, NOW)).toBe(true);
    expect(db.$executeRaw).toHaveBeenCalledOnce();
    const [strings, ...values] = db.$executeRaw.mock.calls[0] as [string[], ...unknown[]];
    const sql = strings.join('?');
    expect(sql).toContain('ON CONFLICT DO NOTHING');
    expect(sql).toContain('"uniqueViewers" = "AuctionStatDaily"."uniqueViewers" + EXCLUDED."uniqueViewers"');
    expect(values[0]).toBe('a1');
    expect(values[1]).toBe(sha('m:m1'));
    expect((values[2] as Date).toISOString()).toBe('2026-11-17T00:00:00.000Z');
  });

  it('skips the seller and unknown / deleted auctions', async () => {
    expect(await recordView('a1', { memberId: 's1' }, NOW)).toBe(false);
    db.auction.findUnique.mockResolvedValue(null);
    expect(await recordView('a1', { memberId: 'm1' }, NOW)).toBe(false);
    db.auction.findUnique.mockResolvedValue({ sellerId: 's1', deletedAt: new Date() });
    expect(await recordView('a1', { memberId: 'm1' }, NOW)).toBe(false);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it('a repeat viewer produces the same key (the SQL dedupes), anonymous viewers use the device cookie', async () => {
    await recordView('a1', { deviceId: 'dv' }, NOW);
    await recordView('a1', { deviceId: 'dv', ip: '2.2.2.2' }, NOW);
    const keys = db.$executeRaw.mock.calls.map((c) => c[2]);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toBe(sha('d:dv'));
  });
});

describe('sellerAnalytics', () => {
  it('aggregates totals, a zero-filled daily series and the top auctions by views', async () => {
    const base = { status: 'LIVE', startTime: new Date('2026-11-01T00:00:00Z'), endTime: new Date('2026-12-01T00:00:00Z'), deletedAt: null };
    db.auction.findMany.mockResolvedValue([
      { id: 'a1', title: 'One', currentBidPaise: 5000n, ...base },
      { id: 'a2', title: 'Two', currentBidPaise: 0n, ...base },
    ]);
    db.auctionStatDaily.groupBy
      .mockResolvedValueOnce([{ auctionId: 'a2', _sum: { views: 30, uniqueViewers: 20 } }, { auctionId: 'a1', _sum: { views: 10, uniqueViewers: 8 } }])
      .mockResolvedValueOnce([{ date: new Date('2026-11-17T00:00:00Z'), _sum: { views: 40 } }]);
    db.watchlist.groupBy.mockResolvedValue([{ auctionId: 'a1', _count: { _all: 4 } }]);
    db.$queryRaw
      .mockResolvedValueOnce([{ auctionId: 'a1', bids: 6, bidders: 3 }])
      .mockResolvedValueOnce([{ d: new Date('2026-11-16T00:00:00Z'), bids: 6 }])
      .mockResolvedValueOnce([{ n: 3 }]);
    db.auction.aggregate.mockResolvedValue({ _count: { _all: 2 }, _sum: { currentBidPaise: 123_400n } });

    const res = await sellerAnalytics('s1', 7, NOW);
    expect(res.range).toEqual({ from: '2026-11-11', to: '2026-11-17' });
    expect(res.totals).toEqual({ views: 40, uniqueViewers: 28, watchers: 4, bids: 6, bidders: 3, sold: 2, revenuePaise: 123_400 });
    expect(res.daily).toHaveLength(7);
    expect(res.daily.at(-1)).toEqual({ date: '2026-11-17', views: 40, bids: 0 });
    expect(res.daily.find((d) => d.date === '2026-11-16')).toEqual({ date: '2026-11-16', views: 0, bids: 6 });
    expect(res.auctions.map((a) => a.id)).toEqual(['a2', 'a1']);
    expect(res.auctions[1]).toEqual({ id: 'a1', title: 'One', status: 'LIVE', views: 10, uniqueViewers: 8, watchers: 4, bids: 6, bidders: 3, currentBidPaise: 5000 });
    expect(db.auction.findMany.mock.calls[0][0].where).toMatchObject({ sellerId: 's1', deletedAt: null });
  });

  it('a seller with no auctions gets zeros and no aggregate queries', async () => {
    db.auction.findMany.mockResolvedValue([]);
    db.auction.aggregate.mockResolvedValue({ _count: { _all: 0 }, _sum: { currentBidPaise: null } });
    const res = await sellerAnalytics('s1', 30, NOW);
    expect(res.totals).toEqual({ views: 0, uniqueViewers: 0, watchers: 0, bids: 0, bidders: 0, sold: 0, revenuePaise: 0 });
    expect(res.daily).toHaveLength(30);
    expect(res.auctions).toEqual([]);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('caps the auctions list at 50', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      id: `a${String(i).padStart(2, '0')}`, title: 't', status: 'LIVE', currentBidPaise: 0n,
      startTime: new Date('2026-11-01T00:00:00Z'), endTime: new Date('2026-12-01T00:00:00Z'), deletedAt: null,
    }));
    db.auction.findMany.mockResolvedValue(rows);
    db.auctionStatDaily.groupBy.mockResolvedValue([]);
    db.watchlist.groupBy.mockResolvedValue([]);
    db.$queryRaw.mockResolvedValue([]);
    db.auction.aggregate.mockResolvedValue({ _count: { _all: 0 }, _sum: { currentBidPaise: null } });
    expect((await sellerAnalytics('s1', 7, NOW)).auctions).toHaveLength(50);
  });
});

describe('auctionAnalytics', () => {
  const auction = { id: 'a1', title: 'One', status: 'LIVE', sellerId: 's1', startTime: new Date('2026-11-01T00:00:00Z'), endTime: new Date('2026-12-01T00:00:00Z'), deletedAt: null };
  beforeEach(() => {
    db.auction.findUnique.mockResolvedValue(auction);
    db.auctionStatDaily.findMany.mockResolvedValue([{ date: new Date('2026-11-17T00:00:00Z'), views: 5, uniqueViewers: 3 }]);
    db.watchlist.count.mockResolvedValue(2);
    db.$queryRaw
      .mockResolvedValueOnce([{ auctionId: 'a1', bids: 4, bidders: 2 }])
      .mockResolvedValueOnce([{ d: '2026-11-17', bids: 4 }]);
  });

  it('owner gets totals and a daily series', async () => {
    const res = await auctionAnalytics('a1', { id: 's1', role: 'MEMBER' }, 7, NOW);
    expect(res.auction).toEqual({ id: 'a1', title: 'One', status: 'LIVE' });
    expect(res.totals).toEqual({ views: 5, uniqueViewers: 3, watchers: 2, bids: 4, bidders: 2 });
    expect(res.daily.at(-1)).toEqual({ date: '2026-11-17', views: 5, uniqueViewers: 3, bids: 4 });
    expect(res.daily).toHaveLength(7);
  });

  it('SUPER_ADMIN may read any auction', async () => {
    await expect(auctionAnalytics('a1', { id: 'admin', role: 'SUPER_ADMIN' }, 7, NOW)).resolves.toBeDefined();
  });

  it('another seller, or a missing auction, is a 404', async () => {
    await expect(auctionAnalytics('a1', { id: 'other', role: 'MEMBER' }, 7, NOW)).rejects.toMatchObject({ statusCode: 404 });
    db.auction.findUnique.mockResolvedValue(null);
    await expect(auctionAnalytics('a1', { id: 's1', role: 'MEMBER' }, 7, NOW)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('retention: viewer purge', () => {
  it('deletes AuctionViewer rows older than 30 days', async () => {
    const { purgeAuctionViewers } = await import('@/modules/admin/retention/admin-retention.service');
    db.auctionViewer.deleteMany.mockResolvedValue({ count: 9 });
    expect(await purgeAuctionViewers()).toBe(9);
    const cutoff = db.auctionViewer.deleteMany.mock.calls[0][0].where.date.lt as Date;
    expect(Math.round((Date.now() - cutoff.getTime()) / 86_400_000)).toBe(30);
  });
});
