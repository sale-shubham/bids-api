import { prisma } from '@/core/prisma/client';
import { NotFound } from '@/core/errors/AppError';
import { toPaise } from '@/core/money';
import { effectiveStatus } from '@/modules/auctions/auctions.serializer';
import { dayDate, eachDay, istDay, rangeFor, viewerKeyFor } from './analytics.rules';

const MAX_SCOPE_AUCTIONS = 1000;
const TOP_AUCTIONS = 50;

type Viewer = { memberId?: string; deviceId?: string; ip?: string; userAgent?: string };

/** Count one view (and a unique viewer when this viewer is new today) in a single statement. */
export async function recordView(auctionId: string, viewer: Viewer, now = new Date()): Promise<boolean> {
  const auction = await prisma.auction.findUnique({ where: { id: auctionId }, select: { sellerId: true, deletedAt: true } });
  if (!auction || auction.deletedAt || (viewer.memberId && viewer.memberId === auction.sellerId)) return false;
  const key = viewerKeyFor(viewer);
  const date = dayDate(istDay(now));
  await prisma.$executeRaw`
    WITH ins AS (
      INSERT INTO "AuctionViewer" ("auctionId", "viewerKey", "date")
      VALUES (${auctionId}, ${key}, ${date}::date)
      ON CONFLICT DO NOTHING
      RETURNING 1
    )
    INSERT INTO "AuctionStatDaily" ("auctionId", "date", "views", "uniqueViewers")
    VALUES (${auctionId}, ${date}::date, 1, (SELECT COUNT(*)::int FROM ins))
    ON CONFLICT ("auctionId", "date") DO UPDATE SET
      "views" = "AuctionStatDaily"."views" + 1,
      "uniqueViewers" = "AuctionStatDaily"."uniqueViewers" + EXCLUDED."uniqueViewers"`;
  return true;
}

type BidAgg = { auctionId: string; bids: number; bidders: number };
type BidDay = { d: Date | string; bids: number };

const dayKey = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));

async function bidsPerAuction(ids: string[], start: Date, end: Date): Promise<Map<string, BidAgg>> {
  if (!ids.length) return new Map();
  const rows = await prisma.$queryRaw<BidAgg[]>`
    SELECT "auctionId", COUNT(*)::int AS bids, COUNT(DISTINCT "bidderId")::int AS bidders
    FROM "Bid" WHERE "auctionId" = ANY(${ids}) AND "createdAt" >= ${start} AND "createdAt" < ${end}
    GROUP BY "auctionId"`;
  return new Map(rows.map((r) => [r.auctionId, r]));
}

async function bidsPerDay(ids: string[], start: Date, end: Date): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const rows = await prisma.$queryRaw<BidDay[]>`
    SELECT (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date AS d, COUNT(*)::int AS bids
    FROM "Bid" WHERE "auctionId" = ANY(${ids}) AND "createdAt" >= ${start} AND "createdAt" < ${end}
    GROUP BY 1`;
  return new Map(rows.map((r) => [dayKey(r.d), r.bids]));
}

async function distinctBidders(ids: string[], start: Date, end: Date): Promise<number> {
  if (!ids.length) return 0;
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT COUNT(DISTINCT "bidderId")::int AS n FROM "Bid"
    WHERE "auctionId" = ANY(${ids}) AND "createdAt" >= ${start} AND "createdAt" < ${end}`;
  return rows[0]?.n ?? 0;
}

export async function sellerAnalytics(sellerId: string, days: number, now = new Date()) {
  const { from, to, start, end } = rangeFor(days, now);
  const auctions = await prisma.auction.findMany({
    where: { sellerId, deletedAt: null, startTime: { lt: end }, endTime: { gte: start } },
    select: { id: true, title: true, status: true, startTime: true, endTime: true, deletedAt: true, currentBidPaise: true },
    orderBy: { endTime: 'desc' },
    take: MAX_SCOPE_AUCTIONS,
  });
  const ids = auctions.map((a) => a.id);
  const dateRange = { gte: dayDate(from), lte: dayDate(to) };

  const [statsPerAuction, statsPerDay, watchers, bidsAgg, bidsDay, bidders, sold] = await Promise.all([
    ids.length
      ? prisma.auctionStatDaily.groupBy({ by: ['auctionId'], where: { auctionId: { in: ids }, date: dateRange }, _sum: { views: true, uniqueViewers: true } })
      : [],
    ids.length ? prisma.auctionStatDaily.groupBy({ by: ['date'], where: { auctionId: { in: ids }, date: dateRange }, _sum: { views: true } }) : [],
    ids.length ? prisma.watchlist.groupBy({ by: ['auctionId'], where: { auctionId: { in: ids } }, _count: { _all: true } }) : [],
    bidsPerAuction(ids, start, end),
    bidsPerDay(ids, start, end),
    distinctBidders(ids, start, end),
    prisma.auction.aggregate({
      where: { sellerId, deletedAt: null, winnerId: { not: null }, endTime: { gte: start, lt: end } },
      _count: { _all: true },
      _sum: { currentBidPaise: true },
    }),
  ]);

  const stat = new Map(statsPerAuction.map((s) => [s.auctionId, s._sum]));
  const watch = new Map(watchers.map((w) => [w.auctionId, w._count._all]));
  const viewsByDay = new Map(statsPerDay.map((s) => [dayKey(s.date), s._sum.views ?? 0]));

  const rows = auctions.map((a) => ({
    id: a.id,
    title: a.title,
    status: effectiveStatus(a, now),
    views: stat.get(a.id)?.views ?? 0,
    uniqueViewers: stat.get(a.id)?.uniqueViewers ?? 0,
    watchers: watch.get(a.id) ?? 0,
    bids: bidsAgg.get(a.id)?.bids ?? 0,
    bidders: bidsAgg.get(a.id)?.bidders ?? 0,
    currentBidPaise: toPaise(a.currentBidPaise),
  }));
  const sum = (k: 'views' | 'uniqueViewers' | 'watchers' | 'bids') => rows.reduce((n, r) => n + r[k], 0);

  return {
    range: { from, to },
    totals: {
      views: sum('views'),
      uniqueViewers: sum('uniqueViewers'),
      watchers: sum('watchers'),
      bids: sum('bids'),
      bidders,
      sold: sold._count._all,
      revenuePaise: toPaise(sold._sum.currentBidPaise ?? 0),
    },
    daily: eachDay(from, to).map((date) => ({ date, views: viewsByDay.get(date) ?? 0, bids: bidsDay.get(date) ?? 0 })),
    auctions: rows.sort((a, b) => b.views - a.views || a.id.localeCompare(b.id)).slice(0, TOP_AUCTIONS),
  };
}

/** Owner (or SUPER_ADMIN) only; anyone else gets a 404 so ids are not probed. */
export async function auctionAnalytics(auctionId: string, viewer: { id: string; role: string }, days: number, now = new Date()) {
  const auction = await prisma.auction.findUnique({
    where: { id: auctionId },
    select: { id: true, title: true, status: true, sellerId: true, startTime: true, endTime: true, deletedAt: true },
  });
  if (!auction || (auction.sellerId !== viewer.id && viewer.role !== 'SUPER_ADMIN')) throw NotFound('Auction not found');
  const { from, to, start, end } = rangeFor(days, now);
  const ids = [auctionId];
  const [stats, watchers, bidsAgg, bidsDay] = await Promise.all([
    prisma.auctionStatDaily.findMany({ where: { auctionId, date: { gte: dayDate(from), lte: dayDate(to) } }, select: { date: true, views: true, uniqueViewers: true } }),
    prisma.watchlist.count({ where: { auctionId } }),
    bidsPerAuction(ids, start, end),
    bidsPerDay(ids, start, end),
  ]);
  const byDay = new Map(stats.map((s) => [dayKey(s.date), s]));
  const daily = eachDay(from, to).map((date) => ({
    date,
    views: byDay.get(date)?.views ?? 0,
    uniqueViewers: byDay.get(date)?.uniqueViewers ?? 0,
    bids: bidsDay.get(date) ?? 0,
  }));
  return {
    auction: { id: auction.id, title: auction.title, status: effectiveStatus(auction, now) },
    totals: {
      views: daily.reduce((n, d) => n + d.views, 0),
      uniqueViewers: daily.reduce((n, d) => n + d.uniqueViewers, 0),
      watchers,
      bids: bidsAgg.get(auctionId)?.bids ?? 0,
      bidders: bidsAgg.get(auctionId)?.bidders ?? 0,
    },
    daily,
  };
}
