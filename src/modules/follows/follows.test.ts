import { beforeEach, describe, expect, it, vi } from 'vitest';

const tx = vi.hoisted(() => ({
  follow: { createMany: vi.fn(), deleteMany: vi.fn() },
  member: { update: vi.fn(), findUnique: vi.fn() },
}));
const db = vi.hoisted(() => ({
  member: { findFirst: vi.fn(), findUnique: vi.fn() },
  follow: { findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn() },
  auction: { groupBy: vi.fn(), count: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock('@/core/prisma/client', () => ({ prisma: db }));

import { followSeller, isFollowing, listFollowing, unfollowSeller } from './follows.service';
import { followingQuerySchema } from './follows.validation';

const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => `${e.statusCode}:${e.code}`,
  );

beforeEach(() => {
  vi.resetAllMocks();
  db.$transaction.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx));
  db.member.findFirst.mockResolvedValue({ id: 's1' });
});

describe('follow rules', () => {
  it('cannot follow yourself (400 INVALID_FOLLOW)', async () => {
    expect(await code(followSeller('s1', 's1'))).toBe('400:INVALID_FOLLOW');
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('target must be an active MEMBER who has listed an auction (404 SELLER_NOT_FOUND)', async () => {
    db.member.findFirst.mockResolvedValue(null);
    expect(await code(followSeller('m1', 's1'))).toBe('404:SELLER_NOT_FOUND');
    expect(db.member.findFirst).toHaveBeenCalledWith({ where: { id: 's1', role: 'MEMBER', isActive: true, auctionsSelling: { some: {} } }, select: { id: true } });
    expect(await code(unfollowSeller('m1', 's1'))).toBe('404:SELLER_NOT_FOUND');
  });
});

describe('follow / unfollow counter', () => {
  it('a new follow increments the counter in the same transaction', async () => {
    tx.follow.createMany.mockResolvedValue({ count: 1 });
    tx.member.update.mockResolvedValue({ followerCount: 5 });
    expect(await followSeller('m1', 's1')).toEqual({ following: true, followerCount: 5 });
    expect(tx.follow.createMany).toHaveBeenCalledWith({ data: [{ followerId: 'm1', sellerId: 's1' }], skipDuplicates: true });
    expect(tx.member.update).toHaveBeenCalledWith({ where: { id: 's1' }, data: { followerCount: { increment: 1 } }, select: { followerCount: true } });
  });

  it('following again is idempotent: no counter change', async () => {
    tx.follow.createMany.mockResolvedValue({ count: 0 });
    tx.member.findUnique.mockResolvedValue({ followerCount: 5 });
    expect(await followSeller('m1', 's1')).toEqual({ following: true, followerCount: 5 });
    expect(tx.member.update).not.toHaveBeenCalled();
  });

  it('unfollow decrements once; a repeat is a no-op success', async () => {
    tx.follow.deleteMany.mockResolvedValue({ count: 1 });
    tx.member.update.mockResolvedValue({ followerCount: 4 });
    expect(await unfollowSeller('m1', 's1')).toEqual({ following: false, followerCount: 4 });
    expect(tx.member.update.mock.calls[0][0].data).toEqual({ followerCount: { decrement: 1 } });

    tx.member.update.mockClear();
    tx.follow.deleteMany.mockResolvedValue({ count: 0 });
    tx.member.findUnique.mockResolvedValue({ followerCount: 4 });
    expect(await unfollowSeller('m1', 's1')).toEqual({ following: false, followerCount: 4 });
    expect(tx.member.update).not.toHaveBeenCalled();
  });
});

describe('following list', () => {
  it('maps sellers with rating, verified flag, live auction count and followedAt', async () => {
    const at = new Date('2026-11-10T00:00:00Z');
    db.follow.findMany.mockResolvedValue([
      { createdAt: at, seller: { id: 's1', name: 'Asha', avatarUrl: null, verifiedAt: new Date(), ratingSum: 9, ratingCount: 2 } },
      { createdAt: at, seller: { id: 's2', name: 'Ravi', avatarUrl: 'u', verifiedAt: null, ratingSum: 0, ratingCount: 0 } },
    ]);
    db.follow.count.mockResolvedValue(2);
    db.auction.groupBy.mockResolvedValue([{ sellerId: 's1', _count: { _all: 3 } }]);
    const { items, meta } = await listFollowing('m1', { page: 1, pageSize: 20 });
    expect(items).toEqual([
      { id: 's1', name: 'Asha', avatarUrl: null, verified: true, ratingAvg: 4.5, ratingCount: 2, activeAuctions: 3, followedAt: at.toISOString() },
      { id: 's2', name: 'Ravi', avatarUrl: 'u', verified: false, ratingAvg: null, ratingCount: 0, activeAuctions: 0, followedAt: at.toISOString() },
    ]);
    expect(meta).toMatchObject({ total: 2, page: 1, pageSize: 20 });
    expect(db.follow.findMany.mock.calls[0][0].where).toEqual({ followerId: 'm1', seller: { isActive: true } });
  });

  it('empty list skips the auction query', async () => {
    db.follow.findMany.mockResolvedValue([]);
    db.follow.count.mockResolvedValue(0);
    expect((await listFollowing('m1', { page: 1, pageSize: 20 })).items).toEqual([]);
    expect(db.auction.groupBy).not.toHaveBeenCalled();
  });

  it('query schema bounds page / pageSize', () => {
    expect(followingQuerySchema.validate({ pageSize: 101 }).error).toBeDefined();
    expect(followingQuerySchema.validate({ page: 0 }).error).toBeDefined();
    expect(followingQuerySchema.validate({}).value).toEqual({ page: 1, pageSize: 20 });
  });
});

describe('isFollowing', () => {
  it('reflects the follow row', async () => {
    db.follow.findUnique.mockResolvedValue({ sellerId: 's1' });
    expect(await isFollowing('m1', 's1')).toBe(true);
    db.follow.findUnique.mockResolvedValue(null);
    expect(await isFollowing('m1', 's1')).toBe(false);
  });
});

describe('public profile', () => {
  it('carries followerCount and isFollowing for the signed-in viewer', async () => {
    const { getPublicProfile } = await import('@/modules/members/members.service');
    db.member.findFirst.mockResolvedValue({
      id: 's1', name: 'Asha', avatarUrl: null, role: 'MEMBER', ratingCount: 0, ratingSum: 0, followerCount: 7, verifiedAt: null, createdAt: new Date(0),
    });
    db.auction.count.mockResolvedValue(0);
    db.follow.findUnique.mockResolvedValue({ sellerId: 's1' });
    expect(await getPublicProfile('s1', 'm1')).toMatchObject({ followerCount: 7, isFollowing: true });
    expect(await getPublicProfile('s1')).toMatchObject({ followerCount: 7, isFollowing: false });
  });

  it('carries listedCount: every auction the member ever created, all statuses', async () => {
    const { getPublicProfile } = await import('@/modules/members/members.service');
    db.member.findFirst.mockResolvedValue({
      id: 's1', name: 'Asha', avatarUrl: null, role: 'MEMBER', ratingCount: 0, ratingSum: 0, followerCount: 0, verifiedAt: null, createdAt: new Date(0),
    });
    db.auction.count.mockImplementation(async ({ where }: any) => (where.sellerId === 's1' && !where.AND ? 5 : 0));
    const p = await getPublicProfile('s1');
    expect(p).toMatchObject({ role: 'MEMBER', listedCount: 5, auctionsSold: 0, activeAuctions: 0 });
  });
});
