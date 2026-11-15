import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  savedSearch: { findMany: vi.fn(), count: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
}));
const enqueue = vi.hoisted(() => vi.fn(async (_m: unknown) => undefined));
vi.mock('@/core/prisma/client', () => ({ prisma: db }));
vi.mock('@/modules/notify/notify.queue', () => ({ enqueueNotification: enqueue }));

import { createSavedSearchSchema } from './saved-searches.validation';
import { createSavedSearch, deleteSavedSearch, toSavedSearchDTO } from './saved-searches.service';
import { onAuctionPublished, titleMatches } from './saved-search.matcher';
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
  it('min <= max, integer prices in range, bounded text, NEW|USED', () => {
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
      { OR: [{ category: null }, { category: 'Watches' }] },
      { OR: [{ condition: null }, { condition: 'USED' }] },
      { OR: [{ minPricePaise: null }, { minPricePaise: { lte: 50_000 } }] },
      { OR: [{ maxPricePaise: null }, { maxPricePaise: { gte: 50_000 } }] },
    ]);
    expect(where.memberId).toEqual({ not: 's1' });
    expect(where.member).toEqual({ isActive: true });
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
