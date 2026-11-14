import { prisma } from '@/core/prisma/client';
import { offsetArgs, pageMeta } from '@/core/http/pagination';
import { toCard, type AuctionRow } from '@/modules/auctions/auctions.serializer';
import { statusWhere } from '@/modules/auctions/auctions.query';

type Status = 'live' | 'upcoming' | 'ended' | 'cancelled';

export async function listAuctions(q: { status?: Status; q?: string; page: number; pageSize: number }, now = new Date()) {
  const and: object[] = [];
  if (q.status) and.push(statusWhere(q.status, now));
  const term = q.q?.trim();
  if (term) {
    and.push({
      OR: [
        { title: { contains: term, mode: 'insensitive' } },
        { seller: { email: { contains: term, mode: 'insensitive' } } },
        { seller: { name: { contains: term, mode: 'insensitive' } } },
      ],
    });
  }
  const where = { AND: and };
  const [rows, total] = await Promise.all([
    prisma.auction.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      include: { seller: { select: { id: true, name: true, avatarUrl: true, email: true } } },
      ...offsetArgs(q),
    }),
    prisma.auction.count({ where }),
  ]);
  const items = rows.map((r) => ({ ...toCard(r as unknown as AuctionRow, now), sellerEmail: r.seller.email }));
  return { items, meta: pageMeta(total, q) };
}
