import { prisma } from '@/core/prisma/client';
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
export function revenueSeries(rows: { amountPaise: number; paidAt: Date | null }[], now: Date) {
  const sums = new Map(lastMonths(now).map((m) => [m, 0]));
  for (const r of rows) {
    if (!r.paidAt) continue;
    const k = monthKey(r.paidAt);
    if (sums.has(k)) sums.set(k, sums.get(k)! + r.amountPaise);
  }
  return [...sums].map(([month, paidPaise]) => ({ month, paidPaise }));
}

export function signupSeries(rows: { role: string; createdAt: Date }[], now: Date) {
  const buckets = new Map(lastMonths(now).map((m) => [m, { month: m, bidders: 0, auctioneers: 0 }]));
  for (const r of rows) {
    const b = buckets.get(monthKey(r.createdAt));
    if (!b) continue;
    if (r.role === 'BIDDER') b.bidders += 1;
    else if (r.role === 'AUCTIONEER') b.auctioneers += 1;
  }
  return [...buckets.values()];
}

export async function getDashboard(now = new Date()) {
  const since = windowStart(now);
  const [members, bidders, auctioneers, live, upcoming, ended, bidsToday, paid, due, paidRows, signupRows, recent] =
    await Promise.all([
      prisma.member.count(),
      prisma.member.count({ where: { role: 'BIDDER' } }),
      prisma.member.count({ where: { role: 'AUCTIONEER' } }),
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
        where: { role: { in: ['BIDDER', 'AUCTIONEER'] }, createdAt: { gte: since } },
        select: { role: true, createdAt: true },
      }),
      prisma.auction.findMany({
        where: { deletedAt: null },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: 5,
        include: auctionInclude,
      }),
    ]);

  return {
    totals: {
      members,
      bidders,
      auctioneers,
      liveAuctions: live,
      upcomingAuctions: upcoming,
      endedAuctions: ended,
      bidsToday,
      commissionPaidPaise: paid._sum.amountPaise ?? 0,
      commissionDuePaise: due._sum.amountPaise ?? 0,
    },
    revenueByMonth: revenueSeries(paidRows, now),
    signupsByMonth: signupSeries(signupRows, now),
    recentAuctions: (recent as AuctionRow[]).map((a) => toCard(a, now)),
  };
}
