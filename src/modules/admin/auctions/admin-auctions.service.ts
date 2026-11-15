import { prisma } from '@/core/prisma/client';
import { offsetArgs, pageMeta } from '@/core/http/pagination';
import { toCard, type AuctionRow } from '@/modules/auctions/auctions.serializer';
import { statusWhere } from '@/modules/auctions/auctions.query';
import { effectiveStatus } from '@/modules/auctions/auctions.serializer';
import { AppError } from '@/core/errors/AppError';
import { toPaiseOrNull } from '@/core/money';

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
  const items = rows.map((r) => ({ ...toCard(r as unknown as AuctionRow, now), sellerEmail: r.seller.email, depositPaise: toPaiseOrNull(r.depositPaise) }));
  return { items, meta: pageMeta(total, q) };
}

/** Admin override of an auction's bid deposit (0 / null = no deposit). Only before the auction ends. */
export async function setDeposit(id: string, depositPaise: number | null, now = new Date()) {
  const a = await prisma.auction.findUnique({
    where: { id },
    select: { id: true, status: true, deletedAt: true, startTime: true, endTime: true },
  });
  if (!a) throw new AppError(404, 'AUCTION_NOT_FOUND', 'Auction not found');
  const eff = effectiveStatus(a, now);
  if (eff === 'ENDED' || eff === 'CANCELLED') throw new AppError(409, 'AUCTION_ENDED', 'This auction has ended or was cancelled');
  const value = depositPaise && depositPaise > 0 ? depositPaise : null;
  const row = await prisma.auction.update({ where: { id }, data: { depositPaise: value }, select: { id: true, depositPaise: true } });
  return { id: row.id, depositPaise: toPaiseOrNull(row.depositPaise) };
}
