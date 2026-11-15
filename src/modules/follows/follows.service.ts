import { prisma } from '@/core/prisma/client';
import { AppError } from '@/core/errors/AppError';
import { offsetArgs, pageMeta } from '@/core/http/pagination';
import { ratingAvg } from '@/modules/reviews/reviews.rules';
import { statusWhere } from '@/modules/auctions/auctions.query';

export type FollowState = { following: boolean; followerCount: number };

async function assertFollowable(followerId: string, sellerId: string) {
  if (followerId === sellerId) throw new AppError(400, 'INVALID_FOLLOW', 'You cannot follow yourself');
  const seller = await prisma.member.findFirst({
    where: { id: sellerId, role: 'AUCTIONEER', isActive: true },
    select: { id: true },
  });
  if (!seller) throw new AppError(404, 'SELLER_NOT_FOUND', 'Seller not found');
}

/** Idempotent follow; the counter moves only when a row was really created, in the same transaction. */
export async function followSeller(followerId: string, sellerId: string): Promise<FollowState> {
  await assertFollowable(followerId, sellerId);
  const followerCount = await prisma.$transaction(async (tx) => {
    const { count } = await tx.follow.createMany({ data: [{ followerId, sellerId }], skipDuplicates: true });
    if (count > 0) {
      const m = await tx.member.update({ where: { id: sellerId }, data: { followerCount: { increment: 1 } }, select: { followerCount: true } });
      return m.followerCount;
    }
    return (await tx.member.findUnique({ where: { id: sellerId }, select: { followerCount: true } }))?.followerCount ?? 0;
  });
  return { following: true, followerCount };
}

/** Idempotent unfollow (same rules as follow, so a stale id is still a 404). */
export async function unfollowSeller(followerId: string, sellerId: string): Promise<FollowState> {
  await assertFollowable(followerId, sellerId);
  const followerCount = await prisma.$transaction(async (tx) => {
    const { count } = await tx.follow.deleteMany({ where: { followerId, sellerId } });
    if (count > 0) {
      const m = await tx.member.update({ where: { id: sellerId }, data: { followerCount: { decrement: 1 } }, select: { followerCount: true } });
      return m.followerCount;
    }
    return (await tx.member.findUnique({ where: { id: sellerId }, select: { followerCount: true } }))?.followerCount ?? 0;
  });
  return { following: false, followerCount };
}

export async function isFollowing(followerId: string, sellerId: string): Promise<boolean> {
  const row = await prisma.follow.findUnique({ where: { followerId_sellerId: { followerId, sellerId } }, select: { sellerId: true } });
  return !!row;
}

export async function listFollowing(followerId: string, q: { page: number; pageSize: number }, now = new Date()) {
  const where = { followerId, seller: { isActive: true } };
  const [rows, total] = await Promise.all([
    prisma.follow.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { sellerId: 'asc' }],
      ...offsetArgs(q),
      select: {
        createdAt: true,
        seller: { select: { id: true, name: true, avatarUrl: true, verifiedAt: true, ratingSum: true, ratingCount: true } },
      },
    }),
    prisma.follow.count({ where }),
  ]);
  const ids = rows.map((r) => r.seller.id);
  const grouped = ids.length
    ? await prisma.auction.groupBy({ by: ['sellerId'], where: { AND: [{ sellerId: { in: ids } }, statusWhere('live', now)] }, _count: { _all: true } })
    : [];
  const live = new Map(grouped.map((g) => [g.sellerId, g._count._all]));
  const items = rows.map((r) => ({
    id: r.seller.id,
    name: r.seller.name,
    avatarUrl: r.seller.avatarUrl,
    verified: !!r.seller.verifiedAt,
    ratingAvg: ratingAvg(r.seller.ratingSum, r.seller.ratingCount),
    ratingCount: r.seller.ratingCount,
    activeAuctions: live.get(r.seller.id) ?? 0,
    followedAt: r.createdAt.toISOString(),
  }));
  return { items, meta: pageMeta(total, q) };
}
