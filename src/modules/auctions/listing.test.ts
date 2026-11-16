import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const ELECTRONICS = vi.hoisted(() => ({
  id: 'cat1',
  slug: 'electronics',
  name: 'Electronics',
  description: null,
  parentId: null,
  sortOrder: 0,
  isActive: true,
  attributeSchema: [
    { key: 'brand', label: 'Brand', type: 'text', required: true },
    { key: 'storage_gb', label: 'Storage', type: 'number', unit: 'GB' },
    { key: 'color', label: 'Colour', type: 'select', options: ['black', 'silver'] },
  ] as unknown[],
}));
const PHONES = vi.hoisted(() => ({ ...ELECTRONICS, id: 'cat2', slug: 'phones', name: 'Phones', parentId: 'cat1', attributeSchema: [] as unknown[] }));
const db = vi.hoisted(() => ({
  auction: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
  member: { findUnique: vi.fn() },
  sellerPayoutAccount: { findUnique: vi.fn() },
  savedSearch: { findMany: vi.fn(async () => []) },
  category: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock('@/core/prisma/client', () => ({ prisma: db }));
vi.mock('@/core/logger/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/core/config/env', () => ({
  env: { storage: { cdnBaseUrl: 'https://cdn.example.com', s3: { bucket: 'b', region: 'ap-south-1' } } },
}));
vi.mock('@/modules/settings/settings.service', () => ({ getSetting: async () => null }));

import * as svc from './auctions.service';
import { attributeFilters, listWhere, orderFor } from './auctions.query';
import { createAuctionSchema, listQuerySchema, updateAuctionSchema, bulkCreateSchema } from './auctions.validation';
import { toCard, toDetail, type AuctionRow } from './auctions.serializer';
import { assertEstimate, toShippingDTO, validateShipping, CONDITIONS } from './listing.rules';
import { listAuctions as adminListAuctions } from '@/modules/admin/auctions/admin-auctions.service';

const H = 3_600_000;
const now = new Date('2026-11-14T10:00:00Z');
const at = (ms: number) => new Date(now.getTime() + ms);
const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => `${e.statusCode}:${e.code}${e.details ? ':' + JSON.stringify(e.details) : ''}`,
  );
const codeOnly = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => `${e.statusCode}:${e.code}`,
  );

const input = {
  title: 'Vintage camera',
  description: '<p>A lovely vintage camera in fine shape.</p>',
  categoryId: 'cat1',
  attributes: { brand: 'Leica' },
  condition: 'GOOD' as const,
  images: ['https://cdn.example.com/auctions/a.png'],
  startingBidPaise: 50_000,
  startTime: at(H),
  endTime: at(5 * H),
};

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    title: 'Vintage camera',
    description: '<p>x</p>',
    category: 'Electronics',
    categoryId: 'cat1',
    categoryRef: { slug: 'electronics' },
    attributes: { brand: 'Leica', old_key: 'gone' },
    condition: 'GOOD',
    conditionReport: '<p>Minor scratches</p>',
    estimateLowPaise: 100_000n,
    estimateHighPaise: 200_000n,
    images: ['https://cdn.example.com/auctions/a.png'],
    videoUrl: 'https://cdn.example.com/auction-videos/v.mp4',
    shippingOptions: { pickup: true, pickupCity: 'Pune', courier: true, shippingFeePaise: 25_000, shipsWithinDays: 3, junk: 1 },
    startingBidPaise: 50_000n,
    minIncrementPaise: 10_000n,
    currentBidPaise: 0n,
    depositPaise: null,
    bidCount: 0,
    status: 'LIVE',
    deletedAt: null,
    startTime: at(-H),
    endTime: at(H),
    endedAt: null,
    reservePricePaise: null,
    buyNowPricePaise: null,
    highestBidderId: null,
    winnerId: null,
    sellerId: 'seller',
    createdAt: now,
    updatedAt: now,
    seller: { id: 'seller', name: 'S', avatarUrl: null, ratingCount: 0, ratingSum: 0, verifiedAt: null },
    ...over,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  db.member.findUnique.mockResolvedValue({ unpaidCommissionPaise: 0n });
  db.category.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === 'cat1' ? ELECTRONICS : where.id === 'cat2' ? PHONES : null,
  );
  db.category.findFirst.mockImplementation(async ({ where }: { where: { OR: { slug?: string }[] } }) =>
    where.OR[0].slug === 'electronics' ? ELECTRONICS : null,
  );
  db.category.findMany.mockResolvedValue([
    { id: 'cat1', parentId: null },
    { id: 'cat2', parentId: 'cat1' },
  ]);
  db.auction.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => row({ ...data }));
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  db.savedSearch.findMany.mockResolvedValue([]);
});

describe('condition grades', () => {
  it('order and Joi enums', () => {
    expect([...CONDITIONS]).toEqual(['NEW', 'LIKE_NEW', 'GOOD', 'FAIR', 'USED', 'FOR_PARTS']);
    const base = { ...input, startTime: new Date(Date.now() + H).toISOString(), endTime: new Date(Date.now() + 5 * H).toISOString() };
    for (const condition of CONDITIONS) {
      expect(createAuctionSchema.validate({ ...base, condition }).error).toBeUndefined();
      expect(listQuerySchema.validate({ condition }).error).toBeUndefined();
    }
    expect(createAuctionSchema.validate({ ...base, condition: 'MINT' }).error).toBeDefined();
    expect(listQuerySchema.validate({ condition: 'MINT' }).error).toBeDefined();
    expect(updateAuctionSchema.validate({ condition: 'FOR_PARTS' }).error).toBeUndefined();
  });
});

describe('create schema: category inputs', () => {
  const base = { ...input, startTime: new Date(Date.now() + H).toISOString(), endTime: new Date(Date.now() + 5 * H).toISOString() };
  it('needs categoryId or the legacy category', () => {
    const { categoryId: _c, ...noCat } = base;
    expect(createAuctionSchema.validate(noCat).error).toBeDefined();
    expect(createAuctionSchema.validate({ ...noCat, category: 'Electronics' }).error).toBeUndefined();
    expect(createAuctionSchema.validate(base).error).toBeUndefined();
  });
  it('videoUrl must be one of our uploads (like images)', () => {
    expect(createAuctionSchema.validate({ ...base, videoUrl: 'https://cdn.example.com/auction-videos/v.mp4' }).error).toBeUndefined();
    expect(createAuctionSchema.validate({ ...base, videoUrl: 'https://evil.com/v.mp4' }).error).toBeDefined();
    expect(updateAuctionSchema.validate({ videoUrl: null }).error).toBeUndefined();
  });
  it('bulk body: 1..50 items', () => {
    expect(bulkCreateSchema.validate({ items: [] }).error).toBeDefined();
    expect(bulkCreateSchema.validate({ items: Array.from({ length: 51 }, () => ({})) }).error).toBeDefined();
    expect(bulkCreateSchema.validate({ items: [{}] }).error).toBeUndefined();
  });
});

describe('estimates', () => {
  const max = 10_000_000_000;
  it('both or neither; low <= high; >= 100; <= ceiling', () => {
    expect(() => assertEstimate(undefined, undefined, max)).not.toThrow();
    expect(() => assertEstimate(null, null, max)).not.toThrow();
    expect(() => assertEstimate(100, 100, max)).not.toThrow();
    for (const [l, h] of [[100, undefined], [undefined, 100], [200, 100], [99, 500], [100, 99], [100, max + 1], [1.5, 200]] as const) {
      expect(() => assertEstimate(l, h, max)).toThrowError(expect.objectContaining({ statusCode: 400, code: 'INVALID_ESTIMATE' }));
    }
  });
  it('create: valid estimate stored as paise; invalid -> 400 INVALID_ESTIMATE and nothing created', async () => {
    await svc.createAuction('seller', { ...input, estimateLowPaise: 100_000, estimateHighPaise: 200_000 }, now);
    expect(db.auction.create.mock.calls[0][0].data).toMatchObject({ estimateLowPaise: 100_000, estimateHighPaise: 200_000 });
    db.auction.create.mockClear();
    expect(await codeOnly(svc.createAuction('seller', { ...input, estimateLowPaise: 300_000, estimateHighPaise: 200_000 }, now))).toBe('400:INVALID_ESTIMATE');
    expect(await codeOnly(svc.createAuction('seller', { ...input, estimateLowPaise: 300_000 }, now))).toBe('400:INVALID_ESTIMATE');
    expect(db.auction.create).not.toHaveBeenCalled();
  });
  it('patch combines with the stored estimate and can clear both', async () => {
    db.auction.findUnique.mockResolvedValue(row());
    db.auction.updateMany.mockResolvedValue({ count: 1 });
    const seller = { sub: 'seller', role: 'MEMBER' as const };
    expect(await codeOnly(svc.updateAuction('a1', seller, { estimateLowPaise: 250_000 }, now))).toBe('400:INVALID_ESTIMATE');
    expect(await codeOnly(svc.updateAuction('a1', seller, { estimateLowPaise: null }, now))).toBe('400:INVALID_ESTIMATE');
    expect(await codeOnly(svc.updateAuction('a1', seller, { estimateLowPaise: null, estimateHighPaise: null }, now))).toBe('ok');
    expect(db.auction.updateMany.mock.calls[0][0].data).toMatchObject({ estimateLowPaise: null, estimateHighPaise: null });
  });
});

describe('condition report', () => {
  it('is sanitised with the description allow-list; empty -> null', async () => {
    await svc.createAuction('seller', { ...input, conditionReport: '<p>Fine</p><script>alert(1)</script><a href="javascript:x">l</a>' }, now);
    const stored = db.auction.create.mock.calls[0][0].data.conditionReport as string;
    expect(stored).toContain('<p>Fine</p>');
    expect(stored).not.toMatch(/script|javascript/);
    await svc.createAuction('seller', { ...input, conditionReport: '<script>x</script>' }, now);
    expect(db.auction.create.mock.calls[1][0].data.conditionReport).toBeNull();
  });
  it('more than 5,000 characters after sanitising -> 400', async () => {
    expect(await codeOnly(svc.createAuction('seller', { ...input, conditionReport: `<p>${'x'.repeat(5001)}</p>` }, now))).toBe('400:VALIDATION_ERROR');
    expect(await codeOnly(svc.createAuction('seller', { ...input, conditionReport: 'x'.repeat(5000) }, now))).toBe('ok');
  });
});

describe('shipping options', () => {
  it('validateShipping matrix', () => {
    expect(validateShipping({ pickup: true, pickupCity: ' Pune ', courier: false })).toEqual({ ok: true, value: { pickup: true, pickupCity: 'Pune', courier: false } });
    expect(validateShipping({ courier: true, shippingFeePaise: 0, shipsWithinDays: 30 })).toEqual({ ok: true, value: { pickup: false, courier: true, shippingFeePaise: 0, shipsWithinDays: 30 } });
    // fields of an option that is off are dropped
    expect(validateShipping({ pickup: false, pickupCity: 'X', courier: true, shippingFeePaise: 5 })).toEqual({ ok: true, value: { pickup: false, courier: true, shippingFeePaise: 5 } });
    expect(validateShipping({ pickup: true, pickupCity: 'X', courier: false, shippingFeePaise: 5 })).toEqual({ ok: true, value: { pickup: true, pickupCity: 'X', courier: false } });
    const bad = [
      { pickup: false, courier: false },
      {},
      { pickup: true, courier: false },
      { pickup: true, pickupCity: 'x'.repeat(61), courier: false },
      { courier: true, shippingFeePaise: -1 },
      { courier: true, shippingFeePaise: 10_000_001 },
      { courier: true, shippingFeePaise: 1.5 },
      { courier: true, shipsWithinDays: 0 },
      { courier: true, shipsWithinDays: 31 },
      { pickup: 'yes', courier: true },
      null,
      [],
    ];
    for (const b of bad) expect(validateShipping(b).ok).toBe(false);
  });
  it('create: invalid -> 400 INVALID_SHIPPING with fields; valid stored from named fields only', async () => {
    const err = await code(svc.createAuction('seller', { ...input, shippingOptions: { pickup: false, courier: false } }, now));
    expect(err).toMatch(/^400:INVALID_SHIPPING:/);
    await svc.createAuction('seller', { ...input, shippingOptions: { pickup: true, pickupCity: 'Pune', courier: true, shippingFeePaise: 100, junk: 1 } as never }, now);
    expect(db.auction.create.mock.calls[0][0].data.shippingOptions).toEqual({ pickup: true, pickupCity: 'Pune', courier: true, shippingFeePaise: 100 });
  });
  it('toShippingDTO fills nulls and tolerates legacy / malformed JSON', () => {
    expect(toShippingDTO({ pickup: true, pickupCity: 'Pune', courier: false })).toEqual({ pickup: true, pickupCity: 'Pune', courier: false, shippingFeePaise: null, shipsWithinDays: null });
    expect(toShippingDTO(null)).toBeNull();
    expect(toShippingDTO({ nonsense: true })).toBeNull();
  });
  it('patch can clear it with null', async () => {
    db.auction.findUnique.mockResolvedValue(row());
    db.auction.updateMany.mockResolvedValue({ count: 1 });
    await svc.updateAuction('a1', { sub: 'seller', role: 'MEMBER' }, { shippingOptions: null }, now);
    expect(db.auction.updateMany.mock.calls[0][0].data.shippingOptions).toBe(Prisma.DbNull);
  });
});

describe('create / update with categories and attributes', () => {
  it('categoryId: writes categoryId + the denormalised name and validated attributes', async () => {
    await svc.createAuction('seller', { ...input, attributes: { brand: 'Leica', storage_gb: '64', color: 'black', junk: 'x' } }, now);
    expect(db.auction.create.mock.calls[0][0].data).toMatchObject({
      categoryId: 'cat1',
      category: 'Electronics',
      attributes: { brand: 'Leica', storage_gb: 64, color: 'black' },
      condition: 'GOOD',
    });
  });
  it('legacy name or slug resolves to the same category (case-insensitive)', async () => {
    const { categoryId: _c, ...rest } = input;
    await svc.createAuction('seller', { ...rest, category: 'electronics' }, now);
    expect(db.auction.create.mock.calls[0][0].data).toMatchObject({ categoryId: 'cat1', category: 'Electronics' });
  });
  it('categoryId wins over the legacy field', async () => {
    await svc.createAuction('seller', { ...input, category: 'whatever' }, now);
    expect(db.category.findFirst).not.toHaveBeenCalled();
  });
  it('unknown / inactive category -> 400 INVALID_CATEGORY', async () => {
    expect(await codeOnly(svc.createAuction('seller', { ...input, categoryId: 'nope' }, now))).toBe('400:INVALID_CATEGORY');
    db.category.findUnique.mockResolvedValue({ ...ELECTRONICS, isActive: false });
    expect(await codeOnly(svc.createAuction('seller', input, now))).toBe('400:INVALID_CATEGORY');
    expect(db.auction.create).not.toHaveBeenCalled();
  });
  it('invalid attributes -> 400 INVALID_ATTRIBUTES with details.fields', async () => {
    const err = await svc.createAuction('seller', { ...input, attributes: { color: 'pink' } }, now).catch((e) => e);
    expect(err).toMatchObject({ statusCode: 400, code: 'INVALID_ATTRIBUTES' });
    expect(err.details.fields.map((f: { field: string }) => f.field).sort()).toEqual(['attributes.brand', 'attributes.color']);
  });
  it('patch: attributes are validated against the stored category; a category change re-validates and rewrites the name', async () => {
    db.auction.findUnique.mockResolvedValue(row());
    db.auction.updateMany.mockResolvedValue({ count: 1 });
    const seller = { sub: 'seller', role: 'MEMBER' as const };
    expect(await codeOnly(svc.updateAuction('a1', seller, { attributes: { color: 'black' } }, now))).toBe('400:INVALID_ATTRIBUTES');
    await svc.updateAuction('a1', seller, { attributes: { brand: 'Nikon' } }, now);
    expect(db.auction.updateMany.mock.calls[0][0].data).toMatchObject({ attributes: { brand: 'Nikon' } });
    await svc.updateAuction('a1', seller, { categoryId: 'cat2' }, now);
    expect(db.auction.updateMany.mock.calls[1][0].data).toMatchObject({ categoryId: 'cat2', category: 'Phones', attributes: Prisma.DbNull });
  });
  it('video and report are editable only while there are no bids', async () => {
    db.auction.findUnique.mockResolvedValue(row({ bidCount: 1 }));
    const seller = { sub: 'seller', role: 'MEMBER' as const };
    expect(await codeOnly(svc.updateAuction('a1', seller, { conditionReport: '<p>x</p>', videoUrl: null }, now))).toBe('409:AUCTION_HAS_BIDS');
  });
});

describe('browse filters in listWhere', () => {
  const base = { status: 'live' as const, page: 1, pageSize: 20 };
  it('category: resolved ids (descendants) -> categoryId in; unresolved falls back to the name column', () => {
    expect(listWhere({ ...base, category: 'electronics' }, now, ['cat1', 'cat2']).AND).toContainEqual({ categoryId: { in: ['cat1', 'cat2'] } });
    expect(listWhere({ ...base, category: 'Legacy' }, now).AND).toContainEqual({ category: 'Legacy' });
  });
  it('listAuctions resolves slug-or-name to the category and its descendants', async () => {
    db.auction.findMany.mockResolvedValue([]);
    db.auction.count.mockResolvedValue(0);
    await svc.listAuctions({ ...base, category: 'electronics' }, now);
    expect(db.auction.count.mock.calls[0][0].where.AND).toContainEqual({ categoryId: { in: ['cat1', 'cat2'] } });
  });
  it('attr filters: strings exact, numeric values also match as numbers (JSON path)', () => {
    expect(attributeFilters({ color: 'black' })).toEqual([{ attributes: { path: ['color'], equals: 'black' } }]);
    expect(attributeFilters({ storage_gb: '64' })).toEqual([
      { OR: [{ attributes: { path: ['storage_gb'], equals: '64' } }, { attributes: { path: ['storage_gb'], equals: 64 } }] },
    ]);
    expect(attributeFilters(undefined)).toEqual([]);
    expect(listWhere({ ...base, attrs: { color: 'black' } }, now).AND).toContainEqual({ attributes: { path: ['color'], equals: 'black' } });
  });
  it('query schema collects attr.<key> params into attrs and caps them at 5', () => {
    const ok = listQuerySchema.validate({ 'attr.color': 'black', 'attr.storage_gb': '64', status: 'live' });
    expect(ok.error).toBeUndefined();
    expect(ok.value).toMatchObject({ attrs: { color: 'black', storage_gb: '64' } });
    expect(Object.keys(ok.value)).not.toContain('attr.color');
    const six = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`attr.k${i}`, 'v']));
    expect(listQuerySchema.validate(six).error).toBeDefined();
    expect(listQuerySchema.validate(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`attr.k${i}`, 'v']))).error).toBeUndefined();
    expect(listQuerySchema.validate({ 'attr.color': 'x'.repeat(201) }).error).toBeDefined();
  });
  it('sold=true: effective ENDED with a winner, overriding status; recentlySold sorts by endedAt desc', () => {
    const w = listWhere({ ...base, sold: true }, now);
    expect(w.AND).toContainEqual({ winnerId: { not: null } });
    expect(JSON.stringify(w)).toContain('"status":"ENDED"');
    expect(JSON.stringify(w)).not.toContain('"startTime"'); // no live window
    expect(orderFor('ended', 'recentlySold')[0]).toEqual({ endedAt: { sort: 'desc', nulls: 'last' } });
    expect(listQuerySchema.validate({ sold: 'true', sort: 'recentlySold' }).error).toBeUndefined();
  });
});

describe('serializers', () => {
  it('card gains categorySlug, estimates, hasVideo, sold and endedAt', () => {
    const c = toCard(row() as unknown as AuctionRow, now);
    expect(c).toMatchObject({ category: 'Electronics', categorySlug: 'electronics', estimateLowPaise: 100_000, estimateHighPaise: 200_000, hasVideo: true, sold: false, endedAt: null });
    expect(JSON.stringify(c)).not.toContain('auction-videos');
    const sold = toCard(row({ status: 'ENDED', winnerId: 'w', endedAt: at(-H), videoUrl: null, estimateLowPaise: null, estimateHighPaise: null }) as unknown as AuctionRow, now);
    expect(sold).toMatchObject({ sold: true, endedAt: at(-H).toISOString(), hasVideo: false, estimateLowPaise: null });
    expect(toCard(row({ status: 'ENDED', winnerId: null }) as unknown as AuctionRow, now).sold).toBe(false);
  });
  it('detail gains categoryId, categoryPath, specs (schema order, unknown keys omitted), report, video and shipping', () => {
    const ctx = {
      path: [{ id: 'cat1', slug: 'electronics', name: 'Electronics' }],
      schema: ELECTRONICS.attributeSchema as never,
    };
    const d = toDetail(row() as unknown as AuctionRow, now, ctx);
    expect(d.categoryId).toBe('cat1');
    expect(d.categoryPath).toEqual(ctx.path);
    expect(d.specs).toEqual([{ key: 'brand', label: 'Brand', value: 'Leica', unit: null }]);
    expect(d.conditionReport).toBe('<p>Minor scratches</p>');
    expect(d.videoUrl).toBe('https://cdn.example.com/auction-videos/v.mp4');
    expect(d.shippingOptions).toEqual({ pickup: true, pickupCity: 'Pune', courier: true, shippingFeePaise: 25_000, shipsWithinDays: 3 });
    expect(toDetail(row({ shippingOptions: null }) as unknown as AuctionRow, now).shippingOptions).toBeNull();
  });
  it('getAuction loads the category path and schema', async () => {
    db.auction.findUnique.mockResolvedValue(row({ attributes: { brand: 'Leica' } }));
    db.category.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => (where.id === 'cat2' ? PHONES : ELECTRONICS));
    db.auction.findUnique.mockResolvedValue(row({ categoryId: 'cat2', attributes: {} }));
    const detail = (await import('./auction-detail.service')).buildAuctionDetail;
    const fakeDb = {
      bid: { findMany: async () => [], aggregate: async () => ({ _max: {} }) },
      member: { findUnique: async () => null },
      watchlist: { count: async () => 0, findUnique: async () => null },
      maxBid: { findUnique: async () => null },
      review: { findUnique: async () => null },
      sale: { findFirst: async () => null },
      auctionDeposit: { findUnique: async () => null },
      strike: { count: async () => 0 },
    };
    const d = await detail(row({ categoryId: 'cat2', attributes: {} }) as unknown as AuctionRow, null, now, fakeDb as never);
    expect(d.categoryPath.map((p) => p.slug)).toEqual(['electronics', 'phones']);
  });
});

describe('bulk create', () => {
  // Bodies arrive as ISO strings and the Joi time-window check uses the real clock.
  const iso = (o: Record<string, unknown> = {}) => ({ ...input, startTime: new Date(Date.now() + H).toISOString(), endTime: new Date(Date.now() + 5 * H).toISOString(), ...o });
  const items = [iso(), iso({ title: 'Second camera' })];
  const now = new Date();
  it('creates every item in one transaction and returns cards', async () => {
    const out = await svc.createAuctionsBulk('seller', items, now);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.auction.create).toHaveBeenCalledTimes(2);
    expect(db.auction.create.mock.calls[0][0].data).toMatchObject({ sellerId: 'seller', status: 'SCHEDULED', categoryId: 'cat1' });
    expect(out.items).toHaveLength(2);
    expect(out.items[0]).toHaveProperty('categorySlug', 'electronics');
    expect(out.items[0]).not.toHaveProperty('reservePricePaise');
    expect(db.savedSearch.findMany).toHaveBeenCalledTimes(2);
  });
  it('all-or-nothing: any bad row -> 400 BULK_INVALID with per-row errors, nothing created', async () => {
    const err = await svc
      .createAuctionsBulk(
        'seller',
        [
          iso({}),
          iso({ title: 'x' }), // Joi
          iso({ attributes: {} }), // service: INVALID_ATTRIBUTES
          iso({ categoryId: 'nope' }), // service: INVALID_CATEGORY
          iso({ reservePricePaise: 1 }), // Joi min 100
          iso({ startingBidPaise: 20_000_000_000 }), // PRICE_TOO_HIGH
          iso({ estimateLowPaise: 500, estimateHighPaise: 400 }),
          iso({ shippingOptions: { pickup: false, courier: false } }),
        ],
        now,
      )
      .catch((e) => e);
    expect(err).toMatchObject({ statusCode: 400, code: 'BULK_INVALID' });
    const rows = err.details.rows as { index: number; errors: { field: string; message: string }[] }[];
    expect(rows.map((r) => r.index)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(rows[0].errors[0].field).toBe('title');
    expect(rows[1].errors.map((e) => e.field)).toEqual(['attributes.brand']);
    expect(rows[2].errors[0].field).toBe('categoryId');
    expect(rows[3].errors[0].field).toBe('reservePricePaise');
    expect(rows[4].errors[0].field).toBe('startingBidPaise');
    expect(rows[5].errors[0].field).toBe('estimateLowPaise');
    expect(rows[6].errors[0].field).toBe('shippingOptions.pickup');
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.auction.create).not.toHaveBeenCalled();
  });
  it('same account blocks as single create: COMMISSION_UNPAID and PAYOUT_ACCOUNT_REQUIRED', async () => {
    db.member.findUnique.mockResolvedValue({ unpaidCommissionPaise: 100n });
    expect(await codeOnly(svc.createAuctionsBulk('seller', items, now))).toBe('403:COMMISSION_UNPAID');
    expect(db.auction.create).not.toHaveBeenCalled();
  });
  it('a failing saved-search matcher never fails the bulk create', async () => {
    db.savedSearch.findMany.mockRejectedValue(new Error('db down'));
    expect((await svc.createAuctionsBulk('seller', items, now)).items).toHaveLength(2);
  });
});

describe('sold archive', () => {
  it('similarSold: same category, sold, within 90 days, excluding itself, newest first, max 6', async () => {
    db.auction.findUnique.mockResolvedValue({ id: 'a1', categoryId: 'cat1', status: 'LIVE', deletedAt: null });
    db.auction.findMany.mockResolvedValue([row({ id: 'b1', status: 'ENDED', winnerId: 'w', endedAt: at(-H) })]);
    const out = await svc.similarSold('a1', now);
    const args = db.auction.findMany.mock.calls[0][0];
    expect(args.take).toBe(6);
    expect(args.orderBy[0]).toEqual({ endedAt: 'desc' });
    expect(args.where.AND).toEqual(
      expect.arrayContaining([
        { winnerId: { not: null } },
        { categoryId: 'cat1' },
        { id: { not: 'a1' } },
        { endedAt: { gte: new Date(now.getTime() - 90 * 86_400_000) } },
      ]),
    );
    expect(out.items[0]).toMatchObject({ id: 'b1', sold: true });
  });
  it('similarSold: 404 for missing / cancelled; empty without a category', async () => {
    db.auction.findUnique.mockResolvedValueOnce(null);
    expect(await codeOnly(svc.similarSold('x', now))).toBe('404:AUCTION_NOT_FOUND');
    db.auction.findUnique.mockResolvedValueOnce({ id: 'a', categoryId: 'c', status: 'CANCELLED', deletedAt: null });
    expect(await codeOnly(svc.similarSold('a', now))).toBe('404:AUCTION_NOT_FOUND');
    db.auction.findUnique.mockResolvedValueOnce({ id: 'a', categoryId: null, status: 'ENDED', deletedAt: null });
    expect(await svc.similarSold('a', now)).toEqual({ items: [] });
    expect(db.auction.findMany).not.toHaveBeenCalled();
  });
});

describe('admin auctions list', () => {
  it('rows include depositPaise (number | null)', async () => {
    const mk = (deposit: bigint | null) => ({ ...row({ depositPaise: deposit }), seller: { id: 's', name: 'S', avatarUrl: null, email: 's@x.test', ratingCount: 0, ratingSum: 0, verifiedAt: null } });
    db.auction.findMany.mockResolvedValue([mk(500_000n), mk(null)]);
    db.auction.count.mockResolvedValue(2);
    const { items } = await adminListAuctions({ page: 1, pageSize: 20 }, now);
    expect(items.map((i) => i.depositPaise)).toEqual([500_000, null]);
    expect(items[0].sellerEmail).toBe('s@x.test');
  });
});
