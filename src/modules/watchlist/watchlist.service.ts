import { prisma } from '@/core/prisma/client';
import { AppError } from '@/core/errors/AppError';
import { pageMeta } from '@/core/http/pagination';
import { enqueueNotification } from '@/modules/notify/notify.queue';
import { auctionInclude, effectiveStatus, toCard, type AuctionRow } from '@/modules/auctions/auctions.serializer';

const MAX_WATCHED = 500; // a watchlist is small; sorted in memory (live first needs a computed status)
export const ENDING_SOON_WINDOW_MS = 60 * 60 * 1000;
const ENDING_SOON_BATCH = 1000;

const notFound = () => new AppError(404, 'AUCTION_NOT_FOUND', 'Auction not found');

type WatchRow = { createdAt: Date; auction: AuctionRow };

const isActive = (a: AuctionRow, now: Date) => {
  const s = effectiveStatus(a, now);
  return s === 'LIVE' || s === 'SCHEDULED';
};

async function loadWatched(memberId: string): Promise<WatchRow[]> {
  const rows = await prisma.watchlist.findMany({
    where: { memberId },
    orderBy: { createdAt: 'desc' },
    take: MAX_WATCHED,
    select: { createdAt: true, auction: { include: auctionInclude } },
  });
  return rows as unknown as WatchRow[];
}

/** Live / upcoming first (soonest end first), then ended (most recently ended first). Cancelled are hidden. */
export function sortWatched(rows: WatchRow[], now: Date): WatchRow[] {
  const visible = rows.filter((r) => effectiveStatus(r.auction, now) !== 'CANCELLED');
  const active = visible
    .filter((r) => isActive(r.auction, now))
    .sort((a, b) => a.auction.endTime.getTime() - b.auction.endTime.getTime() || a.auction.id.localeCompare(b.auction.id));
  const done = visible
    .filter((r) => !isActive(r.auction, now))
    .sort((a, b) => b.auction.endTime.getTime() - a.auction.endTime.getTime() || a.auction.id.localeCompare(b.auction.id));
  return [...active, ...done];
}

export async function listWatchlist(memberId: string, q: { page: number; pageSize: number }, now = new Date()) {
  const sorted = sortWatched(await loadWatched(memberId), now);
  const start = (q.page - 1) * q.pageSize;
  const items = sorted.slice(start, start + q.pageSize).map((r) => ({
    addedAt: r.createdAt.toISOString(),
    auction: toCard(r.auction, now),
  }));
  return { items, meta: pageMeta(sorted.length, q) };
}

export async function watchlistIds(memberId: string, now = new Date()) {
  const rows = sortWatched(await loadWatched(memberId), now);
  return { ids: rows.map((r) => r.auction.id), activeCount: rows.filter((r) => isActive(r.auction, now)).length };
}

/** Idempotent: watching an already-watched auction is a no-op success. */
export async function addToWatchlist(memberId: string, auctionId: string) {
  const auction = await prisma.auction.findUnique({
    where: { id: auctionId },
    select: { id: true, status: true, deletedAt: true },
  });
  if (!auction || auction.deletedAt || auction.status === 'CANCELLED') throw notFound();
  await prisma.watchlist.upsert({
    where: { memberId_auctionId: { memberId, auctionId } },
    create: { memberId, auctionId },
    update: {},
  });
  return { watching: true as const };
}

export async function removeFromWatchlist(memberId: string, auctionId: string) {
  await prisma.watchlist.deleteMany({ where: { memberId, auctionId } });
  return { watching: false as const };
}

/** Called when an auction is republished / rescheduled so watchers can be reminded again. */
export async function resetEndingSoon(auctionId: string) {
  await prisma.watchlist.updateMany({ where: { auctionId }, data: { endingSoonNotifiedAt: null } });
}

/**
 * Ending-soon job: watchers of an effectively-LIVE auction that ends within 60
 * minutes get one `ending-soon` notification. The dedupeKey carries the end
 * time so a republished auction (endTime changes) can notify again, while a
 * re-run for the same cycle is a no-op even if marking fails.
 */
export async function runEndingSoon(now = new Date()): Promise<{ notified: number }> {
  const rows = await prisma.watchlist.findMany({
    where: {
      endingSoonNotifiedAt: null,
      auction: {
        deletedAt: null,
        status: { notIn: ['CANCELLED', 'ENDED'] },
        startTime: { lte: now },
        endTime: { gt: now, lte: new Date(now.getTime() + ENDING_SOON_WINDOW_MS) },
      },
    },
    select: { memberId: true, auctionId: true, auction: { select: { endTime: true, sellerId: true } } },
    orderBy: { createdAt: 'asc' },
    take: ENDING_SOON_BATCH,
  });
  let notified = 0;
  for (const r of rows) {
    // One MEMBER role: a seller may watch their own auction, but is never alerted about it.
    // Marked as handled so the row does not come back on every run.
    if (r.auction.sellerId === r.memberId) {
      await prisma.watchlist.updateMany({
        where: { memberId: r.memberId, auctionId: r.auctionId, endingSoonNotifiedAt: null },
        data: { endingSoonNotifiedAt: now },
      });
      continue;
    }
    await enqueueNotification({
      type: 'ending-soon',
      memberId: r.memberId,
      auctionId: r.auctionId,
      data: { endTime: r.auction.endTime.toISOString() },
      dedupeKey: `ending-soon:${r.auctionId}:${r.memberId}:${r.auction.endTime.getTime()}`,
    });
    await prisma.watchlist.updateMany({
      where: { memberId: r.memberId, auctionId: r.auctionId, endingSoonNotifiedAt: null },
      data: { endingSoonNotifiedAt: now },
    });
    notified += 1;
  }
  return { notified };
}
