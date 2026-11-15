import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  category: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  auction: { groupBy: vi.fn(), count: vi.fn(), updateMany: vi.fn() },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
}));
vi.mock('@/core/prisma/client', () => ({ prisma: db }));

import {
  buildCategoryTree,
  buildSpecs,
  descendantIds,
  slugify,
  validateAttributes,
  type AttributeDef,
} from './categories.rules';
import { createCategorySchema, updateCategorySchema } from './categories.validation';
import * as svc from './categories.service';

const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => `${e.statusCode}:${e.code}`,
  );

const schema: AttributeDef[] = [
  { key: 'brand', label: 'Brand', type: 'text', required: true },
  { key: 'year', label: 'Year', type: 'number', unit: 'yr' },
  { key: 'metal', label: 'Metal', type: 'select', options: ['gold', 'silver'] },
];

describe('validateAttributes', () => {
  const run = (input: unknown, s = schema) => validateAttributes(s, input);
  it('accepts a full valid input and returns typed values', () => {
    expect(run({ brand: ' Rolex ', year: 1999, metal: 'gold' })).toEqual({ ok: true, value: { brand: 'Rolex', year: 1999, metal: 'gold' } });
  });
  it('drops unknown keys', () => {
    expect(run({ brand: 'A', color: 'red' })).toEqual({ ok: true, value: { brand: 'A' } });
  });
  it('required keys: missing, null and empty string all fail', () => {
    for (const v of [{}, { brand: null }, { brand: '' }, { brand: '   ' }]) {
      const r = run(v);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.fields).toEqual([{ field: 'attributes.brand', message: 'Brand is required' }]);
    }
    expect(run(undefined).ok).toBe(false);
    expect(run('nope').ok).toBe(false);
  });
  it('number: finite numbers and numeric strings pass; NaN, Infinity and text fail', () => {
    expect(run({ brand: 'A', year: '2001' })).toEqual({ ok: true, value: { brand: 'A', year: 2001 } });
    for (const year of ['abc', NaN, Infinity, {}, true]) expect(run({ brand: 'A', year }).ok).toBe(false);
  });
  it('select: value must be one of the options', () => {
    expect(run({ brand: 'A', metal: 'silver' }).ok).toBe(true);
    expect(run({ brand: 'A', metal: 'bronze' }).ok).toBe(false);
    expect(run({ brand: 'A', metal: 5 }).ok).toBe(false);
  });
  it('text: at most 200 characters', () => {
    expect(run({ brand: 'x'.repeat(200) }).ok).toBe(true);
    expect(run({ brand: 'x'.repeat(201) }).ok).toBe(false);
  });
  it('collects every error and an optional empty value is skipped', () => {
    const r = run({ year: 'x', metal: 'tin' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fields.map((f) => f.field).sort()).toEqual(['attributes.brand', 'attributes.metal', 'attributes.year']);
    expect(run({ brand: 'A', year: '' })).toEqual({ ok: true, value: { brand: 'A' } });
  });
  it('an empty schema drops everything', () => {
    expect(run({ a: 1 }, [])).toEqual({ ok: true, value: {} });
  });
});

describe('buildSpecs', () => {
  it('follows schema order, adds units and omits unknown / removed keys', () => {
    expect(buildSpecs(schema, { metal: 'gold', old: 'x', brand: 'A', year: 5 })).toEqual([
      { key: 'brand', label: 'Brand', value: 'A', unit: null },
      { key: 'year', label: 'Year', value: 5, unit: 'yr' },
      { key: 'metal', label: 'Metal', value: 'gold', unit: null },
    ]);
    expect(buildSpecs(schema, null)).toEqual([]);
  });
});

describe('slugify', () => {
  it('lower-cases, hyphenates, trims and falls back', () => {
    expect(slugify('Home & Garden')).toBe('home-garden');
    expect(slugify('  --Art!!  ')).toBe('art');
    expect(slugify('!!!')).toBe('category');
    expect(slugify('x'.repeat(100)).length).toBeLessThanOrEqual(60);
  });
});

describe('category tree', () => {
  const row = (id: string, parentId: string | null, sortOrder = 0, name = id) => ({
    id, slug: id, name, description: null, parentId, sortOrder, attributeSchema: [],
  });
  const rows = [row('b', null, 2), row('a', null, 1), row('a2', 'a', 2), row('a1', 'a', 1), row('a1x', 'a1'), row('orphan', 'inactive-parent')];
  it('orders by sortOrder, nests children and drops orphans of inactive parents', () => {
    const tree = buildCategoryTree(rows, new Map());
    expect(tree.map((n) => n.id)).toEqual(['a', 'b']);
    expect(tree[0].children.map((n) => n.id)).toEqual(['a1', 'a2']);
    expect(tree[0].children[0].children.map((n) => n.id)).toEqual(['a1x']);
    expect(JSON.stringify(tree)).not.toContain('orphan');
  });
  it('liveCount includes descendants', () => {
    const tree = buildCategoryTree(rows, new Map([['a', 1], ['a1', 2], ['a1x', 4], ['b', 8], ['a2', 16]]));
    expect(tree[0].liveCount).toBe(1 + 2 + 4 + 16);
    expect(tree[0].children[0].liveCount).toBe(6);
    expect(tree[1].liveCount).toBe(8);
  });
  it('descendantIds covers every level and the root itself', () => {
    expect(descendantIds(rows, 'a').sort()).toEqual(['a', 'a1', 'a1x', 'a2']);
    expect(descendantIds(rows, 'a2')).toEqual(['a2']);
  });
  it('getCategoryTree combines active rows with live counts per category', async () => {
    db.category.findMany.mockResolvedValue([row('a', null), row('a1', 'a')]);
    db.auction.groupBy.mockResolvedValue([{ categoryId: 'a1', _count: { _all: 3 } }, { categoryId: 'a', _count: { _all: 1 } }]);
    const out = await svc.getCategoryTree(new Date('2026-11-15T10:00:00Z'));
    expect(out.items[0]).toMatchObject({ id: 'a', liveCount: 4, children: [{ id: 'a1', liveCount: 3 }] });
    expect(db.category.findMany.mock.calls[0][0].where).toEqual({ isActive: true });
  });
  it('legacy categoriesWithCounts keeps the { name, liveCount } shape', async () => {
    db.category.findMany.mockResolvedValue([row('a', null, 0, 'Art')]);
    db.auction.groupBy.mockResolvedValue([{ categoryId: 'a', _count: { _all: 2 } }]);
    expect(await svc.categoriesWithCounts()).toEqual([{ name: 'Art', liveCount: 2 }]);
  });
});

describe('admin schemas', () => {
  it('create needs a name <= 60; slug pattern; description <= 500', () => {
    expect(createCategorySchema.validate({}).error).toBeDefined();
    expect(createCategorySchema.validate({ name: 'x'.repeat(61) }).error).toBeDefined();
    expect(createCategorySchema.validate({ name: 'Art', slug: 'Bad Slug' }).error).toBeDefined();
    expect(createCategorySchema.validate({ name: 'Art', slug: 'fine-slug', description: 'x'.repeat(501) }).error).toBeDefined();
    expect(createCategorySchema.validate({ name: 'Art', slug: 'fine-slug', parentId: null }).error).toBeUndefined();
  });
  it('attributeSchema: key pattern, label, type, options only for select, unique keys', () => {
    const ok = (a: unknown) => createCategorySchema.validate({ name: 'A', attributeSchema: a }).error;
    expect(ok([{ key: 'brand', label: 'Brand', type: 'text' }])).toBeUndefined();
    expect(ok([{ key: 'Brand', label: 'Brand', type: 'text' }])).toBeDefined();
    expect(ok([{ key: '1a', label: 'x', type: 'text' }])).toBeDefined();
    expect(ok([{ key: 'a'.repeat(41), label: 'x', type: 'text' }])).toBeDefined();
    expect(ok([{ key: 'a', label: 'x'.repeat(61), type: 'text' }])).toBeDefined();
    expect(ok([{ key: 'a', label: 'x', type: 'date' }])).toBeDefined();
    expect(ok([{ key: 'a', label: 'x', type: 'select' }])).toBeDefined();
    expect(ok([{ key: 'a', label: 'x', type: 'select', options: [] }])).toBeDefined();
    expect(ok([{ key: 'a', label: 'x', type: 'select', options: ['one'] }])).toBeUndefined();
    expect(ok([{ key: 'a', label: 'x', type: 'text', options: ['one'] }])).toBeDefined();
    expect(ok([{ key: 'a', label: 'x', type: 'number', unit: 'x'.repeat(13) }])).toBeDefined();
    expect(ok([{ key: 'a', label: 'x', type: 'text' }, { key: 'a', label: 'y', type: 'text' }])).toBeDefined();
    expect(ok(Array.from({ length: 51 }, (_, i) => ({ key: `k${i}`, label: 'x', type: 'select', options: Array.from({ length: 51 }, (_, j) => `o${j}`) })))).toBeDefined();
  });
  it('select with more than 50 options is rejected', () => {
    const options = Array.from({ length: 51 }, (_, i) => `o${i}`);
    expect(createCategorySchema.validate({ name: 'A', attributeSchema: [{ key: 'a', label: 'x', type: 'select', options }] }).error).toBeDefined();
  });
  it('update needs at least one field', () => {
    expect(updateCategorySchema.validate({}).error).toBeDefined();
    expect(updateCategorySchema.validate({ isActive: false }).error).toBeUndefined();
  });
});

const stored = (over: Record<string, unknown> = {}) => ({
  id: 'c1', slug: 'art', name: 'Art', description: null, parentId: null, sortOrder: 0, isActive: true,
  attributeSchema: [], createdAt: new Date(0), updatedAt: new Date(0), _count: { auctions: 0 }, ...over,
});

describe('admin category service', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  });

  it('create generates the slug from the name and de-duplicates a generated one', async () => {
    db.category.findUnique.mockResolvedValueOnce({ id: 'x' }).mockResolvedValueOnce(null);
    db.category.create.mockImplementation(async ({ data }: any) => stored({ ...data }));
    const out = await svc.adminCreateCategory({ name: 'Home & Garden' });
    expect(db.category.create.mock.calls[0][0].data).toMatchObject({ slug: 'home-garden-2', name: 'Home & Garden', parentId: null, isActive: true });
    expect(out.category.slug).toBe('home-garden-2');
  });

  it('create with an explicit slug that exists -> 409 CATEGORY_SLUG_TAKEN', async () => {
    db.category.findUnique.mockResolvedValue({ id: 'x' });
    expect(await code(svc.adminCreateCategory({ name: 'Art', slug: 'art' }))).toBe('409:CATEGORY_SLUG_TAKEN');
    expect(db.category.create).not.toHaveBeenCalled();
  });

  it('a unique-constraint race maps to CATEGORY_SLUG_TAKEN', async () => {
    db.category.findUnique.mockResolvedValue(null);
    db.category.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
    expect(await code(svc.adminCreateCategory({ name: 'Art', slug: 'art' }))).toBe('409:CATEGORY_SLUG_TAKEN');
  });

  it('create with an unknown parent -> 400 INVALID_PARENT', async () => {
    db.category.findUnique.mockResolvedValue(null);
    expect(await code(svc.adminCreateCategory({ name: 'Art', parentId: 'nope' }))).toBe('400:INVALID_PARENT');
  });

  it('patch: moving under itself or a descendant -> 400 CATEGORY_CYCLE', async () => {
    db.category.findUnique.mockResolvedValue({ id: 'a', name: 'A' });
    db.category.findMany.mockResolvedValue([{ id: 'a', parentId: null }, { id: 'b', parentId: 'a' }, { id: 'c', parentId: 'b' }]);
    expect(await code(svc.adminUpdateCategory('a', { parentId: 'a' }))).toBe('400:CATEGORY_CYCLE');
    expect(await code(svc.adminUpdateCategory('a', { parentId: 'c' }))).toBe('400:CATEGORY_CYCLE');
    expect(db.category.update).not.toHaveBeenCalled();
  });

  it('patch: a valid move, null parent and slug clash on another category', async () => {
    db.category.findUnique.mockImplementation(async ({ where }: any) => (where.id ? { id: where.id, name: 'A' } : where.slug === 'taken' ? { id: 'other' } : null));
    db.category.findMany.mockResolvedValue([{ id: 'a', parentId: null }, { id: 'z', parentId: null }]);
    db.category.update.mockResolvedValue(stored({ id: 'a', parentId: 'z' }));
    expect((await svc.adminUpdateCategory('a', { parentId: 'z' })).category.parentId).toBe('z');
    await svc.adminUpdateCategory('a', { parentId: null });
    expect(db.category.update.mock.calls[1][0].data).toEqual({ parentId: null });
    expect(await code(svc.adminUpdateCategory('a', { slug: 'taken' }))).toBe('409:CATEGORY_SLUG_TAKEN');
  });

  it('patch: 404 when missing; renaming also updates the denormalised Auction.category', async () => {
    db.category.findUnique.mockResolvedValueOnce(null);
    expect(await code(svc.adminUpdateCategory('x', { name: 'N' }))).toBe('404:CATEGORY_NOT_FOUND');
    db.category.findUnique.mockResolvedValue({ id: 'a', name: 'Old' });
    db.category.update.mockResolvedValue(stored({ id: 'a', name: 'New' }));
    await svc.adminUpdateCategory('a', { name: 'New' });
    expect(db.auction.updateMany).toHaveBeenCalledWith({ where: { categoryId: 'a' }, data: { category: 'New' } });
  });

  it('delete: in use (auctions or children) -> 409 CATEGORY_IN_USE; else deleted; missing -> 404', async () => {
    db.category.findUnique.mockResolvedValue({ id: 'a', _count: { auctions: 2, children: 0 } });
    expect(await code(svc.adminDeleteCategory('a'))).toBe('409:CATEGORY_IN_USE');
    db.category.findUnique.mockResolvedValue({ id: 'a', _count: { auctions: 0, children: 1 } });
    expect(await code(svc.adminDeleteCategory('a'))).toBe('409:CATEGORY_IN_USE');
    expect(db.category.delete).not.toHaveBeenCalled();
    db.category.findUnique.mockResolvedValue({ id: 'a', _count: { auctions: 0, children: 0 } });
    expect(await svc.adminDeleteCategory('a')).toEqual({ id: 'a' });
    expect(db.category.delete).toHaveBeenCalledWith({ where: { id: 'a' } });
    db.category.findUnique.mockResolvedValue(null);
    expect(await code(svc.adminDeleteCategory('zz'))).toBe('404:CATEGORY_NOT_FOUND');
  });

  it('list is flat with auctionCount and number-safe fields', async () => {
    db.category.findMany.mockResolvedValue([stored({ _count: { auctions: 3 }, isActive: false })]);
    const { items } = await svc.adminListCategories();
    expect(items[0]).toMatchObject({ id: 'c1', isActive: false, auctionCount: 3, attributeSchema: [] });
    expect(Object.keys(items[0]).sort()).toEqual(
      ['attributeSchema', 'auctionCount', 'createdAt', 'description', 'id', 'isActive', 'name', 'parentId', 'slug', 'sortOrder', 'updatedAt'],
    );
  });
});

describe('category stats', () => {
  beforeEach(() => vi.resetAllMocks());
  it('liveCount + sold count + median (descendants included), numerics converted', async () => {
    db.category.findUnique.mockResolvedValue({ id: 'a' });
    db.category.findMany.mockResolvedValue([{ id: 'a', parentId: null }, { id: 'b', parentId: 'a' }]);
    db.auction.count.mockResolvedValue(7);
    db.$queryRaw.mockResolvedValue([{ cnt: 5n, median: '125000.5' }]);
    expect(await svc.categoryStats('Art')).toEqual({ liveCount: 7, soldCount90d: 5, medianSoldPaise: 125001 });
    expect(db.category.findUnique.mock.calls[0][0].where).toEqual({ slug: 'art' });
    expect(db.auction.count.mock.calls[0][0].where.AND[1]).toEqual({ categoryId: { in: ['a', 'b'] } });
  });
  it('no sold lots -> median null', async () => {
    db.category.findUnique.mockResolvedValue({ id: 'a' });
    db.category.findMany.mockResolvedValue([{ id: 'a', parentId: null }]);
    db.auction.count.mockResolvedValue(0);
    db.$queryRaw.mockResolvedValue([{ cnt: 0n, median: null }]);
    expect(await svc.categoryStats('art')).toEqual({ liveCount: 0, soldCount90d: 0, medianSoldPaise: null });
  });
  it('unknown slug -> 404 CATEGORY_NOT_FOUND', async () => {
    db.category.findUnique.mockResolvedValue(null);
    expect(await code(svc.categoryStats('nope'))).toBe('404:CATEGORY_NOT_FOUND');
  });
});

describe('resolution helpers', () => {
  beforeEach(() => vi.resetAllMocks());
  it('resolveActiveCategory by id, by name or slug; inactive / missing -> 400 INVALID_CATEGORY', async () => {
    const cat = { id: 'c1', slug: 'art', name: 'Art', isActive: true, attributeSchema: [{ key: 'a', label: 'A', type: 'text' }] };
    db.category.findUnique.mockResolvedValue(cat);
    expect(await svc.resolveActiveCategory({ categoryId: 'c1' })).toEqual({ id: 'c1', name: 'Art', schema: cat.attributeSchema });
    db.category.findFirst.mockResolvedValue(cat);
    expect((await svc.resolveActiveCategory({ category: 'ART' })).id).toBe('c1');
    expect(db.category.findFirst.mock.calls[0][0].where).toMatchObject({ isActive: true, OR: [{ slug: 'art' }, { name: { equals: 'ART', mode: 'insensitive' } }] });
    db.category.findUnique.mockResolvedValue({ ...cat, isActive: false });
    expect(await code(svc.resolveActiveCategory({ categoryId: 'c1' }))).toBe('400:INVALID_CATEGORY');
    db.category.findFirst.mockResolvedValue(null);
    expect(await code(svc.resolveActiveCategory({ category: 'x' }))).toBe('400:INVALID_CATEGORY');
    expect(await code(svc.resolveActiveCategory({}))).toBe('400:INVALID_CATEGORY');
  });
  it('categoryContext returns root -> leaf and the leaf schema', async () => {
    db.category.findUnique
      .mockResolvedValueOnce({ id: 'c2', slug: 'wrist', name: 'Wrist', parentId: 'c1', attributeSchema: [{ key: 'm', label: 'M', type: 'text' }] })
      .mockResolvedValueOnce({ id: 'c1', slug: 'watches', name: 'Watches', parentId: null, attributeSchema: [] });
    const ctx = await svc.categoryContext('c2');
    expect(ctx.path).toEqual([{ id: 'c1', slug: 'watches', name: 'Watches' }, { id: 'c2', slug: 'wrist', name: 'Wrist' }]);
    expect(ctx.schema).toHaveLength(1);
    expect(await svc.categoryContext(null)).toEqual({ path: [], schema: [] });
  });
  it('resolveBrowseCategoryIds: slug or name -> id + descendants; unknown -> null', async () => {
    db.category.findFirst.mockResolvedValueOnce({ id: 'a' }).mockResolvedValueOnce(null);
    db.category.findMany.mockResolvedValue([{ id: 'a', parentId: null }, { id: 'b', parentId: 'a' }, { id: 'z', parentId: null }]);
    expect(await svc.resolveBrowseCategoryIds('watches')).toEqual(['a', 'b']);
    expect(await svc.resolveBrowseCategoryIds('nothing')).toBeNull();
  });
});
