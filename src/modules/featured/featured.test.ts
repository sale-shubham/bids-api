import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => {
  const d: any = {
    auction: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), count: vi.fn() },
    featurePurchase: { create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    paymentOrder: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    member: { findUnique: vi.fn() },
    memberCredit: { aggregate: vi.fn(), create: vi.fn() },
    appSetting: { findUnique: vi.fn(), findMany: vi.fn() },
    category: { findMany: vi.fn(), findUnique: vi.fn() },
    invoice: { findUnique: vi.fn() },
    $queryRaw: vi.fn(async () => []),
  };
  d.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(d));
  return d;
});
const provider = vi.hoisted(() => ({ publicKey: 'rzp_key', createOrder: vi.fn() }));
const enqueue = vi.hoisted(() => vi.fn(async (_m: unknown) => undefined));
const cats = vi.hoisted(() => ({ resolveBrowseCategoryIds: vi.fn() }));

vi.mock('@/core/prisma/client', () => ({ prisma: db }));
vi.mock('@/core/logger/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/providers/payment', () => ({ paymentProvider: provider }));
vi.mock('@/modules/notify/notify.queue', () => ({ enqueueNotification: enqueue }));
vi.mock('@/modules/categories/categories.service', async (orig) => ({ ...(await orig<object>()), resolveBrowseCategoryIds: cats.resolveBrowseCategoryIds }));

import { applyFeatureDays, parseFeaturePrices, parseFeaturedEnabled } from './featured.rules';
import * as svc from './featured.service';
import { homeFeed, promotedAuctions } from '@/modules/auctions/auctions.service';

const now = new Date('2026-11-16T10:00:00Z');
const DAY = 86_400_000;
const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => `${e.statusCode}:${e.code}`,
  );
const auction = (over: object = {}) => ({
  id: 'a1',
  title: 'Watch',
  status: 'LIVE',
  deletedAt: null,
  startTime: new Date(now.getTime() - DAY),
  endTime: new Date(now.getTime() + 30 * DAY),
  sellerId: 's1',
  featuredUntil: null,
  ...over,
});
const settings = (enabled: string | null = 'true', prices: string | null = null) =>
  db.appSetting.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => {
    const v = where.key === 'featured.enabled' ? enabled : where.key === 'featured.prices' ? prices : null;
    return v === null ? null : { key: where.key, value: v };
  });

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  settings();
  db.auction.findUnique.mockResolvedValue(auction());
  db.member.findUnique.mockResolvedValue({ name: 'S', email: 's@x.co', phone: null });
  db.featurePurchase.create.mockResolvedValue({ id: 'fp1', sellerId: 's1', auctionId: 'a1', days: 3 });
  db.featurePurchase.findMany.mockResolvedValue([]);
  db.featurePurchase.findUnique.mockResolvedValue(null);
  db.paymentOrder.findFirst.mockResolvedValue(null);
  db.memberCredit.aggregate.mockResolvedValue({ _sum: { amountPaise: 100_000n } });
  db.memberCredit.create.mockResolvedValue({ id: 'cr1' });
  provider.createOrder.mockResolvedValue({ gatewayOrderId: 'order_1', keyId: 'rzp_key' });
});

describe('featuredUntil math', () => {
  const end = new Date(now.getTime() + 30 * DAY);
  it('starts from now when not featured or expired, extends from the current end when running', () => {
    expect(applyFeatureDays(now, null, 3, end).getTime()).toBe(now.getTime() + 3 * DAY);
    expect(applyFeatureDays(now, new Date(now.getTime() - DAY), 1, end).getTime()).toBe(now.getTime() + DAY);
    expect(applyFeatureDays(now, new Date(now.getTime() + 2 * DAY), 3, end).getTime()).toBe(now.getTime() + 5 * DAY);
  });
  it('is capped at the auction end time', () => {
    const soon = new Date(now.getTime() + 2 * DAY);
    expect(applyFeatureDays(now, null, 7, soon)).toEqual(soon);
    expect(applyFeatureDays(now, new Date(now.getTime() + 29 * DAY), 7, end)).toEqual(end);
  });
  it('settings parsing falls back to defaults per tier', () => {
    expect(parseFeaturePrices(null)).toEqual({ '1': 9900, '3': 24900, '7': 49900 });
    expect(parseFeaturePrices('{"1":5000,"3":"x","7":-1}')).toEqual({ '1': 5000, '3': 24900, '7': 49900 });
    expect(parseFeaturePrices('not json')['1']).toBe(9900);
    expect(parseFeaturedEnabled(null)).toBe(true);
    expect(parseFeaturedEnabled('false')).toBe(false);
  });
});

describe('POST feature checkout', () => {
  it('Razorpay path: PENDING purchase + FEATURE order, standard payload, no transfers', async () => {
    const r = (await svc.checkout('s1', 'a1', { days: 3 }, now)) as { orderId: string; amountPaise: number; keyId: string };
    expect(r).toMatchObject({ orderId: 'order_1', amountPaise: 24_900, currency: 'INR', keyId: 'rzp_key' });
    expect(db.featurePurchase.create.mock.calls[0][0].data).toMatchObject({ status: 'PENDING', days: 3, amountPaise: 24_900n });
    const order = db.paymentOrder.create.mock.calls[0][0].data;
    expect(order).toMatchObject({ referenceType: 'FEATURE', referenceId: 'fp1', amountPaise: 24_900n });
    expect(provider.createOrder.mock.calls[0][0]).not.toHaveProperty('transfers');
  });

  it('uses admin-edited prices', async () => {
    settings('true', '{"1":1234,"3":2345,"7":3456}');
    const r = (await svc.checkout('s1', 'a1', { days: 7 }, now)) as { amountPaise: number };
    expect(r.amountPaise).toBe(3456);
  });

  it('credits path: debits the ledger (member row locked), marks PAID and applies featuredUntil', async () => {
    const r = await svc.checkout('s1', 'a1', { days: 1, useCredits: true }, now);
    expect(r).toEqual({ paidWithCredits: true, featuredUntil: new Date(now.getTime() + DAY) });
    expect(db.$queryRaw).toHaveBeenCalled();
    expect(db.memberCredit.create.mock.calls[0][0].data).toMatchObject({ amountPaise: -9900n, reason: 'FEATURE_PURCHASE' });
    expect(db.featurePurchase.create.mock.calls[0][0].data).toMatchObject({ status: 'PAID', paidWith: 'CREDITS' });
    expect(db.auction.update).toHaveBeenCalledWith({ where: { id: 'a1' }, data: { featuredUntil: new Date(now.getTime() + DAY) } });
    expect(enqueue.mock.calls[0][0]).toMatchObject({ type: 'feature-activated', memberId: 's1' });
    expect(provider.createOrder).not.toHaveBeenCalled();
  });

  it('credits path with too little balance -> 409 INSUFFICIENT_CREDITS and nothing applied', async () => {
    db.memberCredit.aggregate.mockResolvedValue({ _sum: { amountPaise: 100n } });
    expect(await code(svc.checkout('s1', 'a1', { days: 1, useCredits: true }, now))).toBe('409:INSUFFICIENT_CREDITS');
    expect(db.memberCredit.create).not.toHaveBeenCalled();
    expect(db.auction.update).not.toHaveBeenCalled();
  });

  it('ended / cancelled auction -> 409 AUCTION_ENDED', async () => {
    db.auction.findUnique.mockResolvedValue(auction({ endTime: new Date(now.getTime() - 1000) }));
    expect(await code(svc.checkout('s1', 'a1', { days: 1 }, now))).toBe('409:AUCTION_ENDED');
    db.auction.findUnique.mockResolvedValue(auction({ status: 'CANCELLED' }));
    expect(await code(svc.checkout('s1', 'a1', { days: 1 }, now))).toBe('409:AUCTION_ENDED');
  });

  it('feature disabled -> 409 FEATURE_DISABLED; not the owner -> 404', async () => {
    settings('false');
    expect(await code(svc.checkout('s1', 'a1', { days: 1 }, now))).toBe('409:FEATURE_DISABLED');
    settings();
    expect(await code(svc.checkout('other', 'a1', { days: 1 }, now))).toBe('404:AUCTION_NOT_FOUND');
  });

  it('reuses a recent CREATED order for the same purchase', async () => {
    db.featurePurchase.findMany.mockResolvedValue([{ id: 'fp0' }]);
    db.paymentOrder.findFirst.mockResolvedValue({ gatewayOrderId: 'order_old' });
    const r = (await svc.checkout('s1', 'a1', { days: 3 }, now)) as { orderId: string };
    expect(r.orderId).toBe('order_old');
    expect(provider.createOrder).not.toHaveBeenCalled();
  });
});

describe('markFeaturePaid', () => {
  beforeEach(() => {
    db.paymentOrder.findUnique.mockResolvedValue({ id: 'po1', referenceType: 'FEATURE', referenceId: 'fp1' });
    db.featurePurchase.findUnique.mockResolvedValue({ id: 'fp1', sellerId: 's1', auctionId: 'a1', days: 3 });
  });
  it('guarded PENDING -> PAID applies once and notifies', async () => {
    db.featurePurchase.updateMany.mockResolvedValue({ count: 1 });
    const r = await svc.markFeaturePaid({ paymentOrderId: 'po1', gatewayPaymentId: 'pay_1' }, now);
    expect(r).toEqual({ applied: true, purchaseId: 'fp1' });
    expect(db.featurePurchase.updateMany.mock.calls[0][0].where).toEqual({ id: 'fp1', status: 'PENDING' });
    expect(db.auction.update).toHaveBeenCalledWith({ where: { id: 'a1' }, data: { featuredUntil: new Date(now.getTime() + 3 * DAY) } });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
  it('a redelivery does not extend again', async () => {
    db.featurePurchase.updateMany.mockResolvedValue({ count: 0 });
    const r = await svc.markFeaturePaid({ paymentOrderId: 'po1' }, now);
    expect(r.applied).toBe(false);
    expect(db.auction.update).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('home feed + promoted', () => {
  const card = (id: string, extra: object = {}) => ({
    id,
    title: id,
    category: 'Art',
    categoryRef: { slug: 'art' },
    condition: 'GOOD',
    images: [],
    startingBidPaise: 100n,
    currentBidPaise: 0n,
    bidCount: 0,
    minIncrementPaise: 10n,
    startTime: new Date(now.getTime() - DAY),
    endTime: new Date(now.getTime() + DAY),
    status: 'LIVE',
    deletedAt: null,
    winnerId: null,
    endedAt: null,
    featuredUntil: null,
    seller: { id: 's', name: 'S', avatarUrl: null, ratingCount: 0, ratingSum: 0, verifiedAt: null },
    ...extra,
  });
  const until = new Date(now.getTime() + DAY);

  it('promoted first (featuredUntil asc), filled with most-bids, no duplicates, cards flagged', async () => {
    db.auction.findMany.mockImplementation(async (args: { where: { AND?: unknown[] }; orderBy: object[] }) => {
      const first = JSON.stringify(args.orderBy[0]);
      if (first.includes('featuredUntil')) return [card('p1', { featuredUntil: until }), card('p2', { featuredUntil: until })];
      if (first.includes('bidCount')) return [card('p2', { featuredUntil: until }), card('b1'), card('b2')];
      return [];
    });
    const feed = await homeFeed(now);
    expect(feed.featured.map((c) => c.id)).toEqual(['p1', 'p2', 'b1', 'b2']);
    expect(feed.featured.map((c) => c.promoted)).toEqual([true, true, false, false]);
  });

  it('filters promoted by featuredUntil > now', async () => {
    db.auction.findMany.mockResolvedValue([]);
    await homeFeed(now);
    const promotedCall = db.auction.findMany.mock.calls.find((c: any[]) => JSON.stringify(c[0].orderBy[0]).includes('featuredUntil'));
    expect(JSON.stringify(promotedCall![0].where)).toContain('"featuredUntil":{"gt":');
  });

  it('GET /auctions/promoted: live promoted only, category resolved with descendants, limit applied', async () => {
    cats.resolveBrowseCategoryIds.mockResolvedValue(['c1', 'c2']);
    db.auction.findMany.mockResolvedValue([card('p1', { featuredUntil: until })]);
    const r = await promotedAuctions({ category: 'art', limit: 2 }, now);
    expect(r.items.map((i) => i.id)).toEqual(['p1']);
    const args = db.auction.findMany.mock.calls[0][0];
    expect(args.take).toBe(2);
    expect(JSON.stringify(args.where)).toContain('"categoryId":{"in":["c1","c2"]}');
    cats.resolveBrowseCategoryIds.mockResolvedValue(null);
    expect(await promotedAuctions({ category: 'nope', limit: 2 }, now)).toEqual({ items: [] });
  });
});
