import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  auction: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
    groupBy: vi.fn(),
  },
  member: { findUnique: vi.fn() },
  watchlist: { count: vi.fn(async () => 0), findUnique: vi.fn(async () => null), updateMany: vi.fn(async () => ({ count: 0 })) },
  bid: { findMany: vi.fn(async () => []), aggregate: vi.fn(async () => ({ _max: { amountPaise: null } })) },
}));
vi.mock('@/core/prisma/client', () => ({ prisma: db }));
vi.mock('@/core/config/env', () => ({
  env: { storage: { cdnBaseUrl: 'https://cdn.example.com', s3: { bucket: 'b', region: 'ap-south-1' } } },
}));
const settings = vi.hoisted(() => ({ map: {} as Record<string, string> }));
vi.mock('@/modules/settings/settings.service', () => ({
  getSetting: async (k: string) => settings.map[k] ?? null,
}));

import { effectiveStatus } from './auctions.serializer';
import { priceFilter, statusWhere } from './auctions.query';
import {
  checkTimeWindow,
  createAuctionSchema,
  republishSchema,
  sanitizeDescription,
  updateAuctionSchema,
} from './auctions.validation';
import * as svc from './auctions.service';

const H = 3600_000;
const now = new Date('2026-11-14T10:00:00Z');
const at = (ms: number) => new Date(now.getTime() + ms);

describe('effectiveStatus', () => {
  const base = { status: 'SCHEDULED' as const, deletedAt: null, startTime: at(-H), endTime: at(H) };
  it('is LIVE between start and end regardless of stored SCHEDULED', () => {
    expect(effectiveStatus(base, now)).toBe('LIVE');
  });
  it('is SCHEDULED before start', () => {
    expect(effectiveStatus({ ...base, startTime: at(H), endTime: at(2 * H) }, now)).toBe('SCHEDULED');
  });
  it('is ENDED at/after endTime even if stored LIVE, and when stored ENDED', () => {
    expect(effectiveStatus({ ...base, status: 'LIVE', endTime: now }, now)).toBe('ENDED');
    expect(effectiveStatus({ ...base, status: 'ENDED' }, now)).toBe('ENDED');
  });
  it('CANCELLED wins (status or deletedAt)', () => {
    expect(effectiveStatus({ ...base, status: 'CANCELLED' }, now)).toBe('CANCELLED');
    expect(effectiveStatus({ ...base, deletedAt: now, endTime: at(-1) }, now)).toBe('CANCELLED');
  });
});

describe('checkTimeWindow', () => {
  it('rejects start in the past beyond 2 min, allows within', () => {
    expect(checkTimeWindow(at(-3 * 60_000), at(2 * H), now)).toMatch(/past/);
    expect(checkTimeWindow(at(-60_000), at(2 * H), now)).toBeNull();
  });
  it('enforces 1 hour .. 30 days', () => {
    expect(checkTimeWindow(at(0), at(H - 1), now)).toMatch(/1 hour/);
    expect(checkTimeWindow(at(0), at(H), now)).toBeNull();
    expect(checkTimeWindow(at(0), at(30 * 24 * H), now)).toBeNull();
    expect(checkTimeWindow(at(0), at(30 * 24 * H + 1), now)).toMatch(/30 days/);
  });
});

describe('create / patch validation', () => {
  const start = new Date(Date.now() + H);
  const valid = {
    title: 'Vintage camera',
    description: '<p>A lovely vintage camera in fine shape.</p>',
    category: 'Electronics',
    condition: 'USED',
    images: ['https://cdn.example.com/auctions/a.png'],
    startingBidPaise: 50000,
    startTime: start.toISOString(),
    endTime: new Date(start.getTime() + 24 * H).toISOString(),
  };
  it('accepts a valid body', () => expect(createAuctionSchema.validate(valid).error).toBeUndefined());
  it('rejects foreign image hosts and bad counts', () => {
    expect(createAuctionSchema.validate({ ...valid, images: ['https://evil.com/a.png'] }).error).toBeDefined();
    expect(createAuctionSchema.validate({ ...valid, images: [] }).error).toBeDefined();
    const nine = Array.from({ length: 9 }, (_, i) => `https://cdn.example.com/a${i}.png`);
    expect(createAuctionSchema.validate({ ...valid, images: nine }).error).toBeDefined();
  });
  it('rejects bad time windows, short title, low bid', () => {
    expect(createAuctionSchema.validate({ ...valid, endTime: valid.startTime }).error).toBeDefined();
    expect(createAuctionSchema.validate({ ...valid, startTime: new Date(Date.now() - H).toISOString() }).error).toBeDefined();
    expect(createAuctionSchema.validate({ ...valid, title: 'abc' }).error).toBeDefined();
    expect(createAuctionSchema.validate({ ...valid, startingBidPaise: 99 }).error).toBeDefined();
    expect(createAuctionSchema.validate({ ...valid, minIncrementPaise: 50 }).error).toBeDefined();
  });
  it('patch: all optional but at least one field; republish needs both times', () => {
    expect(updateAuctionSchema.validate({}).error).toBeDefined();
    expect(updateAuctionSchema.validate({ title: 'New title' }).error).toBeUndefined();
    expect(republishSchema.validate({ startTime: valid.startTime }).error).toBeDefined();
    expect(republishSchema.validate({ startTime: valid.startTime, endTime: valid.endTime }).error).toBeUndefined();
  });
});

describe('sanitizeDescription', () => {
  it('strips script tags and event handlers, keeps allowed markup', () => {
    const out = sanitizeDescription(
      '<p onclick="x()">Hi <strong>there</strong></p><script>alert(1)</script><a href="javascript:alert(1)">bad</a><a href="https://e.com" onclick="y()">ok</a><img src=x onerror=z()>',
    );
    expect(out).not.toMatch(/script|onclick|onerror|javascript:|<img/i);
    expect(out).toContain('<strong>there</strong>');
    expect(out).toContain('href="https://e.com"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
  });
});

describe('priceFilter / statusWhere', () => {
  it('is undefined without bounds', () => expect(priceFilter()).toBeUndefined());
  it('applies bounds to startingBid when no bids and to currentBid when bids exist', () => {
    expect(priceFilter(100, 500)).toEqual({
      OR: [
        { bidCount: 0, startingBidPaise: { gte: 100, lte: 500 } },
        { bidCount: { gt: 0 }, currentBidPaise: { gte: 100, lte: 500 } },
      ],
    });
    expect(priceFilter(undefined, 500)).toEqual({
      OR: [
        { bidCount: 0, startingBidPaise: { lte: 500 } },
        { bidCount: { gt: 0 }, currentBidPaise: { lte: 500 } },
      ],
    });
  });
  it('status filters are time-based and exclude cancelled', () => {
    expect(statusWhere('live', now)).toMatchObject({ deletedAt: null, startTime: { lte: now }, endTime: { gt: now } });
    expect(statusWhere('upcoming', now)).toMatchObject({ deletedAt: null, startTime: { gt: now } });
    expect(statusWhere('ended', now)).toMatchObject({ deletedAt: null, status: { not: 'CANCELLED' } });
  });
});

describe('service ownership / 409 rules', () => {
  const seller = { sub: 'seller', role: 'AUCTIONEER' as const };
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'a1',
    sellerId: 'seller',
    bidCount: 0,
    status: 'SCHEDULED',
    deletedAt: null,
    startTime: at(H),
    endTime: at(5 * H),
    images: [],
    seller: { id: 'seller', name: 'S', avatarUrl: null },
    createdAt: now,
    updatedAt: now,
    ...over,
  });
  const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => `${e.statusCode}:${e.code}`);

  beforeEach(() => {
    vi.clearAllMocks();
    settings.map = { 'auction.categories': JSON.stringify(['Electronics']) };
  });

  it('patch: non-owner gets 404', async () => {
    db.auction.findUnique.mockResolvedValue(row({ sellerId: 'other' }));
    expect(await code(svc.updateAuction('a1', seller, { title: 'New title' }, now))).toBe('404:AUCTION_NOT_FOUND');
    expect(await code(svc.updateAuction('a1', { sub: 'x', role: 'SUPER_ADMIN' }, { title: 'New title' }, now))).toBe(
      '404:AUCTION_NOT_FOUND',
    );
  });
  it('patch: bids -> AUCTION_HAS_BIDS; ended/cancelled -> AUCTION_ENDED', async () => {
    db.auction.findUnique.mockResolvedValue(row({ bidCount: 2 }));
    expect(await code(svc.updateAuction('a1', seller, { title: 'New title' }, now))).toBe('409:AUCTION_HAS_BIDS');
    db.auction.findUnique.mockResolvedValue(row({ startTime: at(-5 * H), endTime: at(-H) }));
    expect(await code(svc.updateAuction('a1', seller, { title: 'New title' }, now))).toBe('409:AUCTION_ENDED');
    db.auction.findUnique.mockResolvedValue(row({ status: 'CANCELLED' }));
    expect(await code(svc.updateAuction('a1', seller, { title: 'New title' }, now))).toBe('409:AUCTION_ENDED');
    expect(db.auction.updateMany).not.toHaveBeenCalled();
  });
  it('patch: happy path updates with the bidCount=0 guard', async () => {
    db.auction.findUnique.mockResolvedValue(row());
    db.auction.updateMany.mockResolvedValue({ count: 1 });
    expect(await code(svc.updateAuction('a1', seller, { title: 'New title' }, now))).toBe('ok');
    expect(db.auction.updateMany).toHaveBeenCalledWith({
      where: { id: 'a1', bidCount: 0, deletedAt: null },
      data: { title: 'New title' },
    });
  });
  it('patch: a bid racing in (count 0) -> AUCTION_HAS_BIDS', async () => {
    db.auction.findUnique.mockResolvedValue(row());
    db.auction.updateMany.mockResolvedValue({ count: 0 });
    expect(await code(svc.updateAuction('a1', seller, { title: 'New title' }, now))).toBe('409:AUCTION_HAS_BIDS');
  });
  it('delete: seller blocked by bids; admin always; others 404', async () => {
    db.auction.findUnique.mockResolvedValue({ sellerId: 'seller', bidCount: 3, deletedAt: null });
    expect(await code(svc.deleteAuction('a1', seller, now))).toBe('409:AUCTION_HAS_BIDS');
    expect(await code(svc.deleteAuction('a1', { sub: 'z', role: 'AUCTIONEER' }, now))).toBe('404:AUCTION_NOT_FOUND');
    db.auction.update.mockResolvedValue({});
    expect(await svc.deleteAuction('a1', { sub: 'admin', role: 'SUPER_ADMIN' }, now)).toEqual({ id: 'a1' });
    expect(db.auction.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { status: 'CANCELLED', deletedAt: now },
    });
  });
  it('republish: only effective ENDED with zero bids', async () => {
    const times = { startTime: at(H), endTime: at(3 * H) };
    db.auction.findUnique.mockResolvedValue(row()); // still scheduled
    expect(await code(svc.republishAuction('a1', seller, times, now))).toBe('409:AUCTION_NOT_REPUBLISHABLE');
    db.auction.findUnique.mockResolvedValue(row({ bidCount: 1, startTime: at(-5 * H), endTime: at(-H) }));
    expect(await code(svc.republishAuction('a1', seller, times, now))).toBe('409:AUCTION_NOT_REPUBLISHABLE');
    db.auction.findUnique.mockResolvedValue(row({ startTime: at(-5 * H), endTime: at(-H), status: 'LIVE' }));
    db.auction.updateMany.mockResolvedValue({ count: 1 });
    expect(await code(svc.republishAuction('a1', seller, times, now))).toBe('ok');
    expect(db.auction.updateMany.mock.calls[0][0].data).toMatchObject({
      status: 'SCHEDULED',
      endedAt: null,
      winnerId: null,
    });
  });
  it('create: unpaid commission -> 403 COMMISSION_UNPAID; unknown category -> 400', async () => {
    const input = {
      title: 'Vintage camera',
      description: '<p>A lovely vintage camera in fine shape.</p>',
      category: 'Electronics',
      condition: 'USED' as const,
      images: ['https://cdn.example.com/a.png'],
      startingBidPaise: 50000,
      startTime: at(H),
      endTime: at(5 * H),
    };
    db.member.findUnique.mockResolvedValue({ unpaidCommissionPaise: 1 });
    expect(await code(svc.createAuction('seller', input, now))).toBe('403:COMMISSION_UNPAID');
    db.member.findUnique.mockResolvedValue({ unpaidCommissionPaise: 0 });
    expect(await code(svc.createAuction('seller', { ...input, category: 'Nope' }, now))).toBe('400:VALIDATION_ERROR');
    expect(db.auction.create).not.toHaveBeenCalled();
  });
  it('detail: cancelled hidden from the public, visible to seller / admin', async () => {
    db.auction.findUnique.mockResolvedValue(row({ status: 'CANCELLED' }));
    expect(await code(svc.getAuction('a1', undefined, now))).toBe('404:AUCTION_NOT_FOUND');
    expect(await code(svc.getAuction('a1', { sub: 'other', role: 'BIDDER' }, now))).toBe('404:AUCTION_NOT_FOUND');
    expect(await code(svc.getAuction('a1', seller, now))).toBe('ok');
    expect(await code(svc.getAuction('a1', { sub: 'adm', role: 'SUPER_ADMIN' }, now))).toBe('ok');
  });
});
