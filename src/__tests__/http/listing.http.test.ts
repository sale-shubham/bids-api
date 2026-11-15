import { bearer, getApp, prismaMock, resetPrismaMock } from './harness';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('@/core/prisma/client', async () => ({ prisma: (await import('./harness')).prismaMock }));
vi.mock('@/core/middleware/pgRateLimitStore', async () => ({ PgRateLimitStore: (await import('./harness')).PassStore }));
vi.mock('@/core/logger/logger', async () => ({ logger: (await import('./harness')).silentLogger }));

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

beforeEach(() => resetPrismaMock());

const cat = (over: Record<string, unknown> = {}) => ({
  id: 'c1', slug: 'art', name: 'Art', description: null, parentId: null, sortOrder: 0, isActive: true,
  attributeSchema: [], createdAt: new Date(0), updatedAt: new Date(0), _count: { auctions: 0 }, ...over,
});

describe('public categories', () => {
  it('GET /categories -> { items } tree, cacheable', async () => {
    prismaMock.category.findMany.mockResolvedValue([cat(), cat({ id: 'c2', slug: 'prints', name: 'Prints', parentId: 'c1' })]);
    prismaMock.auction.groupBy.mockResolvedValue([{ categoryId: 'c2', _count: { _all: 2 } }]);
    const res = await request(await getApp()).get('/categories');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/public/);
    expect(res.body.data.items).toEqual([
      expect.objectContaining({ id: 'c1', liveCount: 2, children: [expect.objectContaining({ id: 'c2', liveCount: 2, children: [] })] }),
    ]);
  });

  it('GET /auctions/categories keeps the legacy shape', async () => {
    prismaMock.category.findMany.mockResolvedValue([cat()]);
    prismaMock.auction.groupBy.mockResolvedValue([{ categoryId: 'c1', _count: { _all: 3 } }]);
    const res = await request(await getApp()).get('/auctions/categories');
    expect(res.body.data).toEqual({ categories: [{ name: 'Art', liveCount: 3 }] });
  });

  it('GET /categories/:slug/stats -> counts and median; 404 for an unknown slug', async () => {
    prismaMock.category.findUnique.mockResolvedValueOnce({ id: 'c1' });
    prismaMock.category.findMany.mockResolvedValue([{ id: 'c1', parentId: null }]);
    prismaMock.auction.count.mockResolvedValue(4);
    prismaMock.$queryRaw.mockResolvedValue([{ cnt: 9n, median: 250000 }]);
    const ok = await request(await getApp()).get('/categories/art/stats');
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({ liveCount: 4, soldCount90d: 9, medianSoldPaise: 250000 });
    prismaMock.category.findUnique.mockResolvedValueOnce(null);
    const missing = await request(await getApp()).get('/categories/nope/stats');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('CATEGORY_NOT_FOUND');
  });

  it('GET /auctions/:id/similar-sold -> 404 for an unknown auction, { items } otherwise', async () => {
    prismaMock.auction.findUnique.mockResolvedValueOnce(null);
    expect((await request(await getApp()).get('/auctions/zz/similar-sold')).body.error.code).toBe('AUCTION_NOT_FOUND');
    prismaMock.auction.findUnique.mockResolvedValueOnce({ id: 'a1', categoryId: null, status: 'LIVE', deletedAt: null });
    const res = await request(await getApp()).get('/auctions/a1/similar-sold');
    expect(res.body.data).toEqual({ items: [] });
  });
});

describe('admin categories', () => {
  const admin = async () => bearer('SUPER_ADMIN', 'admin1');
  it('POST creates (201), duplicate slug -> 409 CATEGORY_SLUG_TAKEN', async () => {
    prismaMock.category.findUnique.mockResolvedValue(null);
    prismaMock.category.create.mockImplementation(async ({ data }: { data: object }) => cat({ ...data }));
    const res = await request(await getApp()).post('/admin/categories').set('Authorization', await admin()).send({ name: 'Home & Garden' });
    expect(res.status).toBe(201);
    expect(res.body.data.category).toMatchObject({ slug: 'home-garden', name: 'Home & Garden' });
    prismaMock.category.findUnique.mockResolvedValue({ id: 'x' });
    const dup = await request(await getApp()).post('/admin/categories').set('Authorization', await admin()).send({ name: 'Art', slug: 'art' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CATEGORY_SLUG_TAKEN');
  });
  it('PATCH cycle -> 400 CATEGORY_CYCLE; DELETE in use -> 409 CATEGORY_IN_USE', async () => {
    prismaMock.category.findUnique.mockResolvedValue({ id: 'c1', name: 'Art' });
    prismaMock.category.findMany.mockResolvedValue([{ id: 'c1', parentId: null }, { id: 'c2', parentId: 'c1' }]);
    const cyc = await request(await getApp()).patch('/admin/categories/c1').set('Authorization', await admin()).send({ parentId: 'c2' });
    expect(cyc.status).toBe(400);
    expect(cyc.body.error.code).toBe('CATEGORY_CYCLE');
    prismaMock.category.findUnique.mockResolvedValue({ id: 'c1', _count: { auctions: 1, children: 0 } });
    const del = await request(await getApp()).delete('/admin/categories/c1').set('Authorization', await admin());
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe('CATEGORY_IN_USE');
  });
  it('GET lists every category with auctionCount', async () => {
    prismaMock.category.findMany.mockResolvedValue([cat({ isActive: false, _count: { auctions: 5 } })]);
    const res = await request(await getApp()).get('/admin/categories').set('Authorization', await admin());
    expect(res.body.data.items[0]).toMatchObject({ isActive: false, auctionCount: 5 });
  });
});

describe('POST /auctions/bulk', () => {
  const item = {
    title: 'Vintage brass telescope',
    description: 'A fully working brass telescope in excellent condition.',
    categoryId: 'c1',
    condition: 'FAIR',
    images: ['https://cdn.noblebid.test/auctions/a.jpg'],
    startingBidPaise: 50_000,
    startTime: iso(HOUR),
    endTime: iso(3 * HOUR),
  };
  const post = async (items: unknown[]) =>
    request(await getApp()).post('/auctions/bulk').set('Authorization', await bearer('AUCTIONEER', 'seller1')).send({ items });

  beforeEach(() => {
    prismaMock.member.findUnique.mockResolvedValue({ id: 'seller1', isActive: true, unpaidCommissionPaise: 0n });
    prismaMock.appSetting.findUnique.mockResolvedValue(null);
    prismaMock.category.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === 'c1' ? { id: 'c1', slug: 'art', name: 'Art', isActive: true, parentId: null, attributeSchema: [] } : null,
    );
  });

  it('400 BULK_INVALID lists per-row errors and creates nothing', async () => {
    const res = await post([item, { ...item, categoryId: 'nope' }, { ...item, title: 'x' }]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BULK_INVALID');
    expect(res.body.error.details.rows).toEqual([
      { index: 1, errors: [{ field: 'categoryId', message: expect.any(String) }] },
      { index: 2, errors: [{ field: 'title', message: expect.any(String) }] },
    ]);
    expect(prismaMock.auction.create).not.toHaveBeenCalled();
  });

  it('201 { items } when every row is valid', async () => {
    prismaMock.auction.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: `a${Math.random()}`, ...data, categoryRef: { slug: 'art' }, bidCount: 0, currentBidPaise: 0n, deletedAt: null, endedAt: null, winnerId: null,
      seller: { id: 'seller1', name: 'S', avatarUrl: null, ratingCount: 0, ratingSum: 0, verifiedAt: null },
    }));
    prismaMock.savedSearch.findMany.mockResolvedValue([]);
    const res = await post([item, { ...item, title: 'Second telescope' }]);
    expect(res.status).toBe(201);
    expect(res.body.data.items).toHaveLength(2);
    expect(res.body.data.items[0]).toMatchObject({ category: 'Art', categorySlug: 'art', condition: 'FAIR', hasVideo: false, sold: false });
    expect(prismaMock.auction.create).toHaveBeenCalledTimes(2);
  });
});

describe('POST /sales/:id/checkout delivery choice', () => {
  it('400 DELIVERY_CHOICE_REQUIRED when the auction offers both and no choice is sent', async () => {
    prismaMock.sale.findFirst.mockResolvedValue({
      id: 's1', status: 'AWAITING_PAYMENT', payBy: new Date(Date.now() + 86_400_000), sellerId: 'seller1',
      itemPaise: 100_000n, shippingFeePaise: 0n, deliveryChoice: null, amountPaise: 100_000n, commissionPaise: 5_000n,
      auction: { title: 'Watch', shippingOptions: { pickup: true, pickupCity: 'Pune', courier: true, shippingFeePaise: 500 } },
    });
    prismaMock.sellerPayoutAccount.findUnique.mockResolvedValue({ status: 'ACTIVE', razorpayAccountId: 'acc_1' });
    prismaMock.member.findUnique.mockResolvedValue({ id: 'm1', isActive: true, name: 'B', email: 'b@x.test', phone: null });
    const res = await request(await getApp()).post('/sales/s1/checkout').set('Authorization', await bearer('BIDDER', 'm1')).send();
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DELIVERY_CHOICE_REQUIRED');
  });
});
