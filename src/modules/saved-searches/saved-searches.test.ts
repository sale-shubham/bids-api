import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  savedSearch: { findMany: vi.fn(), count: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
  follow: { findMany: vi.fn(async (_a?: unknown) => [] as { followerId: string }[]) },
  member: { findUnique: vi.fn(async () => ({ name: 'Seller One' })) },
  category: { findFirst: vi.fn(async () => null as unknown), findUnique: vi.fn(async () => null as unknown) },
}));
const enqueue = vi.hoisted(() => vi.fn(async (_m: unknown) => undefined));
vi.mock('@/core/prisma/client', () => ({ prisma: db }));
vi.mock('@/modules/notify/notify.queue', () => ({ enqueueNotification: enqueue }));

import { createSavedSearchSchema } from './saved-searches.validation';
import { createSavedSearch, deleteSavedSearch, toSavedSearchDTO } from './saved-searches.service';
import { notifyFollowers, onAuctionPublished, titleMatches } from './saved-search.matcher';
import { HARD_MAX_PRICE_PAISE } from '@/core/money';

const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => `${e.statusCode}:${e.code}`,
  );

beforeEach(() => vi.clearAllMocks());

describe('validation', () => {
  const bad = (v: unknown) => createSavedSearchSchema.validate(v).error?.message;
  it('needs at least one criterion', () => {
    expect(bad({})).toMatch(/at least one/);
    expect(bad({ name: 'x' })).toMatch(/at least one/);
    expect(bad({ q: 'watch' })).toBeUndefined();
    expect(bad({ minPricePaise: 0 })).toBeUndefined();
  });
  it('min <= max, integer prices in range, bounded text, condition grades', () => {
    expect(bad({ minPricePaise: 500, maxPricePaise: 100 })).toMatch(/must not exceed/);
    expect(bad({ minPricePaise: 100, maxPricePaise: 100 })).toBeUndefined();
    expect(bad({ minPricePaise: -1 })).toBeDefined();
    expect(bad({ minPricePaise: 1.5 })).toBeDefined();
    expect(bad({ maxPricePaise: HARD_MAX_PRICE_PAISE + 1 })).toBeDefined();
    expect(bad({ q: 'x'.repeat(101) })).toBeDefined();
    expect(bad({ q: 'a', name: 'x'.repeat(61) })).toBeDefined();
    expect(bad({ condition: 'BROKEN' })).toBeDefined();
  });
});

describe('service', () => {
  it('create: 10 per member then SAVED_SEARCH_LIMIT', async () => {
    db.savedSearch.count.mockResolvedValue(10);
    expect(await code(createSavedSearch('m1', { q: 'watch' }))).toBe('409:SAVED_SEARCH_LIMIT');
    expect(db.savedSearch.create).not.toHaveBeenCalled();
  });
  it('create stores the criteria and returns the number-typed DTO', async () => {
    db.savedSearch.count.mockResolvedValue(2);
    db.savedSearch.create.mockImplementation(async ({ data }: any) => ({ id: 's1', createdAt: new Date(0), ...data, minPricePaise: 100n }));
    const out = await createSavedSearch('m1', { q: 'watch', minPricePaise: 100 });
    expect(out.savedSearch).toMatchObject({ id: 's1', q: 'watch', minPricePaise: 100, maxPricePaise: null, category: null });
  });
  it('create stores a category given as slug under its canonical name', async () => {
    db.savedSearch.count.mockResolvedValue(0);
    db.category.findFirst.mockResolvedValueOnce({ id: 'c1', name: 'Watches', slug: 'watches' });
    db.savedSearch.create.mockImplementation(async ({ data }: any) => ({ id: 's1', createdAt: new Date(0), ...data }));
    const out = await createSavedSearch('m1', { category: 'watches' });
    expect(out.savedSearch.category).toBe('Watches');
  });
  it('accepts every condition grade', () => {
    const bad = (v: unknown) => createSavedSearchSchema.validate(v).error;
    for (const c of ['NEW', 'LIKE_NEW', 'GOOD', 'FAIR', 'USED', 'FOR_PARTS']) expect(bad({ condition: c })).toBeUndefined();
    expect(bad({ condition: 'BROKEN' })).toBeDefined();
  });
  it('delete: own only, else 404', async () => {
    db.savedSearch.deleteMany.mockResolvedValue({ count: 0 });
    expect(await code(deleteSavedSearch('m1', 's9'))).toBe('404:NOT_FOUND');
    expect(db.savedSearch.deleteMany).toHaveBeenCalledWith({ where: { id: 's9', memberId: 'm1' } });
    db.savedSearch.deleteMany.mockResolvedValue({ count: 1 });
    expect(await deleteSavedSearch('m1', 's1')).toEqual({ id: 's1' });
  });
  it('DTO converts bigint to number', () => {
    const dto = toSavedSearchDTO({
      id: 'x',
      name: null,
      q: null,
      category: 'Art',
      condition: 'NEW',
      minPricePaise: 5n,
      maxPricePaise: null,
      createdAt: new Date(0),
    });
    expect(dto.minPricePaise).toBe(5);
  });
});

describe('matcher', () => {
  const auction = { id: 'a1', title: 'Vintage Swiss Watch', category: 'Watches', condition: 'USED' as const, startingBidPaise: 50_000, sellerId: 's1' };
  it('titleMatches: every word, any case, empty matches all', () => {
    expect(titleMatches(null, 'Anything')).toBe(true);
    expect(titleMatches('swiss WATCH', 'Vintage Swiss Watch')).toBe(true);
    expect(titleMatches('swiss  clock', 'Vintage Swiss Watch')).toBe(false);
  });
  it('queries candidates by category, condition, price, seller and active member', async () => {
    db.savedSearch.findMany.mockResolvedValue([]);
    await onAuctionPublished(auction);
    const where = db.savedSearch.findMany.mock.calls[0][0].where;
    expect(where.AND).toEqual([
      { OR: [{ category: null }, { category: { in: ['Watches'] } }] },
      { OR: [{ condition: null }, { condition: 'USED' }] },
      { OR: [{ minPricePaise: null }, { minPricePaise: { lte: 50_000 } }] },
      { OR: [{ maxPricePaise: null }, { maxPricePaise: { gte: 50_000 } }] },
    ]);
    expect(where.memberId).toEqual({ not: 's1' });
    expect(where.member).toEqual({ isActive: true });
  });
  it('a search for a parent category matches descendants: names and slugs of every ancestor are accepted', async () => {
    db.category.findUnique
      .mockResolvedValueOnce({ name: 'Wrist watches', slug: 'wrist-watches', parentId: 'c1' })
      .mockResolvedValueOnce({ name: 'Watches', slug: 'watches', parentId: null });
    db.savedSearch.findMany.mockResolvedValue([]);
    await onAuctionPublished({ ...auction, category: 'Wrist watches', categoryId: 'c2' });
    const where = db.savedSearch.findMany.mock.calls[0][0].where;
    expect(where.AND[0]).toEqual({ OR: [{ category: null }, { category: { in: ['Wrist watches', 'wrist-watches', 'Watches', 'watches'] } }] });
  });
  it('notifies one member once, filtering by title words, with the dedupe key', async () => {
    db.savedSearch.findMany.mockResolvedValue([
      { memberId: 'm1', name: 'Swiss', q: 'swiss watch' },
      { memberId: 'm1', name: 'Second', q: null },
      { memberId: 'm2', name: null, q: 'clock' },
      { memberId: 'm3', name: 'All', q: null },
    ]);
    expect(await onAuctionPublished(auction)).toBe(2);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledWith({
      type: 'saved-search-match',
      memberId: 'm1',
      auctionId: 'a1',
      data: { searchName: 'Swiss' },
      dedupeKey: 'ssm:a1:m1',
    });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ memberId: 'm3', dedupeKey: 'ssm:a1:m3' }));
  });
  it('caps at 500 members', async () => {
    db.savedSearch.findMany.mockResolvedValue(Array.from({ length: 600 }, (_, i) => ({ memberId: `m${i}`, name: null, q: null })));
    expect(await onAuctionPublished(auction)).toBe(500);
  });
});

describe('follower fan-out', () => {
  const auction = { id: 'a1', title: 'Watch', category: 'Watches', condition: 'GOOD' as const, startingBidPaise: 1000, sellerId: 's1' };

  it('notifies active followers with the dedupe key, url data and seller name', async () => {
    db.follow.findMany.mockResolvedValue([{ followerId: 'f1' }, { followerId: 'f2' }]);
    expect(await notifyFollowers(auction)).toBe(2);
    expect(enqueue).toHaveBeenCalledWith({
      type: 'followed-seller-listed',
      memberId: 'f1',
      auctionId: 'a1',
      data: { sellerName: 'Seller One' },
      dedupeKey: 'fsl:a1:f1',
    });
    const args = db.follow.findMany.mock.calls[0][0] as { where: unknown; take: number };
    expect(args.where).toEqual({ sellerId: 's1', follower: { isActive: true } });
    expect(args.take).toBe(2000);
  });

  it('skips members already notified by a saved search in the same run', async () => {
    db.follow.findMany.mockResolvedValue([{ followerId: 'f1' }, { followerId: 'f2' }]);
    db.savedSearch.findMany.mockResolvedValue([{ memberId: 'f1', name: 'x', q: null }]);
    await onAuctionPublished({ ...auction, categoryId: null });
    const types = enqueue.mock.calls.map((c) => `${(c[0] as { type: string }).type}:${(c[0] as { memberId: string }).memberId}`);
    expect(types).toEqual(['saved-search-match:f1', 'followed-seller-listed:f2']);
  });

  it('never notifies the seller themselves', async () => {
    db.follow.findMany.mockResolvedValue([{ followerId: 's1' }]);
    expect(await notifyFollowers(auction)).toBe(0);
  });
});
