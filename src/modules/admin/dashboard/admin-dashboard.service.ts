import { prisma } from '@/core/prisma/client';
import { toPaise, toPaiseOrNull } from '@/core/money';
import { auctionInclude, toCard, type AuctionRow } from '@/modules/auctions/auctions.serializer';
import { statusWhere } from '@/modules/auctions/auctions.query';

const IST_OFFSET_MS = 330 * 60 * 1000; // buckets follow the Indian calendar
const MONTHS = 12;

/** 'YYYY-MM' of an instant in IST. */
export function monthKey(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 7);
}

/** The last `count` month keys (oldest first), ending at the month of `now`. */
export function lastMonths(now: Date, count = MONTHS): string[] {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  return Array.from({ length: count }, (_, i) => new Date(Date.UTC(y, m - (count - 1 - i), 1)).toISOString().slice(0, 7));
}

/** First instant of the oldest month in the window (IST midnight, as a UTC Date). */
export function windowStart(now: Date, count = MONTHS): Date {
  const [y, m] = lastMonths(now, count)[0].split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1) - IST_OFFSET_MS);
}

export function startOfDayIst(now: Date): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_OFFSET_MS);
}

/** Zero-filled monthly series: every month of the window is present. */
export function revenueSeries(rows: { amountPaise: bigint | number; paidAt: Date | null }[], now: Date) {
  const sums = new Map(lastMonths(now).map((m) => [m, 0]));
  for (const r of rows) {
    if (!r.paidAt) continue;
    const k = monthKey(r.paidAt);
    if (sums.has(k)) sums.set(k, sums.get(k)! + toPaise(r.amountPaise));
  }
  return [...sums].map(([month, paidPaise]) => ({ month, paidPaise }));
}

export function signupSeries(rows: { createdAt: Date }[], now: Date) {
  const buckets = new Map(lastMonths(now).map((m) => [m, { month: m, members: 0 }]));
  for (const r of rows) {
    const b = buckets.get(monthKey(r.createdAt));
    if (b) b.members += 1;
  }
  return [...buckets.values()];
}

/** Sales count and amount per status; every status is present (zero-filled). */
export function salesByStatus(rows: { status: string; _count: { _all: number }; _sum: { amountPaise: bigint | number | null } }[]) {
  const out: Record<string, { count: number; amountPaise: number }> = {};
  for (const s of ['AWAITING_PAYMENT', 'PAID', 'SHIPPED', 'DELIVERED', 'RELEASED', 'DISPUTED', 'REFUNDED', 'CANCELLED']) {
    out[s] = { count: 0, amountPaise: 0 };
  }
  for (const r of rows) out[r.status] = { count: r._count._all, amountPaise: toPaiseOrNull(r._sum.amountPaise) ?? 0 };
  return out;
}

export async function getDashboard(now = new Date()) {
  const since = windowStart(now);
  const [members, buyers, sellers, live, upcoming, ended, bidsToday, paid, due, paidRows, signupRows, recent, saleRows] =
    await Promise.all([
      prisma.member.count({ where: { role: 'MEMBER' } }),
      // Buyers placed at least one bid; sellers listed at least one auction (any status).
      prisma.member.count({ where: { role: 'MEMBER', bids: { some: {} } } }),
      prisma.member.count({ where: { role: 'MEMBER', auctionsSelling: { some: {} } } }),
      prisma.auction.count({ where: statusWhere('live', now) }),
      prisma.auction.count({ where: statusWhere('upcoming', now) }),
      prisma.auction.count({ where: statusWhere('ended', now) }),
      prisma.bid.count({ where: { createdAt: { gte: startOfDayIst(now) } } }),
      prisma.commission.aggregate({ where: { status: 'PAID' }, _sum: { amountPaise: true } }),
      prisma.commission.aggregate({ where: { status: 'DUE' }, _sum: { amountPaise: true } }),
      prisma.commission.findMany({
        where: { status: 'PAID', paidAt: { gte: since } },
        select: { amountPaise: true, paidAt: true },
      }),
      prisma.member.findMany({
        where: { role: 'MEMBER', createdAt: { gte: since } },
        select: { createdAt: true },
      }),
      prisma.auction.findMany({
        where: { deletedAt: null },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: 5,
        include: auctionInclude,
      }),
      prisma.sale.groupBy({ by: ['status'], _count: { _all: true }, _sum: { amountPaise: true } }),
    ]);

  return {
    totals: {
      members,
      buyers,
      sellers,
      liveAuctions: live,
      upcomingAuctions: upcoming,
      endedAuctions: ended,
      bidsToday,
      commissionPaidPaise: toPaiseOrNull(paid._sum.amountPaise) ?? 0,
      commissionDuePaise: toPaiseOrNull(due._sum.amountPaise) ?? 0,
    },
    salesByStatus: salesByStatus(saleRows),
    revenueByMonth: revenueSeries(paidRows, now),
    signupsByMonth: signupSeries(signupRows, now),
    recentAuctions: (recent as AuctionRow[]).map((a) => toCard(a, now)),
  };
}
