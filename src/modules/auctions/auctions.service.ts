import { prisma } from '@/core/prisma/client';
import { AppError } from '@/core/errors/AppError';
import { logger } from '@/core/logger/logger';
import { offsetArgs, pageMeta } from '@/core/http/pagination';
import { buildAuctionDetail } from './auction-detail.service';
import { resetEndingSoon } from '@/modules/watchlist/watchlist.service';
import { getSetting } from '@/modules/settings/settings.service';
import { assertWithinMaxPrice, getMaxPricePaise } from '@/modules/settings/max-price';
import { toPaise } from '@/core/money';
import { auctionInclude, effectiveStatus, toCard, toDetail, type AuctionRow } from './auctions.serializer';
import { effectivePrice, listWhere, orderFor, statusWhere } from './auctions.query';
import {
  checkTimeWindow,
  sanitizeDescription,
  type CreateAuctionInput,
  type ListQuery,
  type MineQuery,
  type UpdateAuctionInput,
} from './auctions.validation';

const DEFAULT_MIN_INCREMENT_PAISE = 10_000;
const HOME_LIMIT = 8;

type Actor = { sub: string; role: 'BIDDER' | 'AUCTIONEER' | 'SUPER_ADMIN' };

export const auctionNotFound = () => new AppError(404, 'AUCTION_NOT_FOUND', 'Auction not found');
const hasBids = () => new AppError(409, 'AUCTION_HAS_BIDS', 'This auction already has bids');
const ended = () => new AppError(409, 'AUCTION_ENDED', 'This auction has ended or was cancelled');
const invalid = (message: string) =>
  new AppError(400, 'VALIDATION_ERROR', message, [{ field: '', message }]);

// ---------------------------------------------------------------- reads

async function fetchCards(where: object, orderBy: object[], skip?: number, take?: number) {
  const rows = await prisma.auction.findMany({ where, orderBy, skip, take, include: auctionInclude });
  return rows as AuctionRow[];
}

export async function listAuctions(q: ListQuery, now = new Date()) {
  const where = listWhere(q, now);
  const paging = { page: q.page, pageSize: q.pageSize };

  if (q.sort === 'priceAsc' || q.sort === 'priceDesc') {
    // The "price" is computed (bids ? currentBid : startingBid), which Prisma cannot
    // ORDER BY — sort the (tiny) projection in memory, then load only the page.
    // TODO: switch to raw SQL ORDER BY GREATEST(...) if the live catalogue gets large.
    const slimRows = await prisma.auction.findMany({
      where,
      select: { id: true, bidCount: true, currentBidPaise: true, startingBidPaise: true, endTime: true },
    });
    const slim = slimRows.map((r) => ({
      ...r,
      currentBidPaise: toPaise(r.currentBidPaise),
      startingBidPaise: toPaise(r.startingBidPaise),
    }));
    const dir = q.sort === 'priceAsc' ? 1 : -1;
    slim.sort(
      (a, b) =>
        dir * (effectivePrice(a) - effectivePrice(b)) ||
        a.endTime.getTime() - b.endTime.getTime() ||
        a.id.localeCompare(b.id),
    );
    const { skip, take } = offsetArgs(paging);
    const ids = slim.slice(skip, skip + take).map((r) => r.id);
    const rows = ids.length ? await fetchCards({ id: { in: ids } }, [{ id: 'asc' }]) : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const items = ids.map((id) => byId.get(id)).filter((r): r is AuctionRow => !!r);
    return { items: items.map((r) => toCard(r, now)), meta: pageMeta(slim.length, paging) };
  }

  const { skip, take } = offsetArgs(paging);
  const [rows, total] = await Promise.all([
    fetchCards(where, orderFor(q.status, q.sort), skip, take),
    prisma.auction.count({ where }),
  ]);
  return { items: rows.map((r) => toCard(r, now)), meta: pageMeta(total, paging) };
}

export async function homeFeed(now = new Date()) {
  const [featured, endingSoon, upcoming] = await Promise.all([
    fetchCards(statusWhere('live', now), [{ bidCount: 'desc' }, { endTime: 'asc' }, { id: 'asc' }], 0, HOME_LIMIT),
    fetchCards(statusWhere('live', now), [{ endTime: 'asc' }, { id: 'asc' }], 0, HOME_LIMIT),
    fetchCards(statusWhere('upcoming', now), [{ startTime: 'asc' }, { id: 'asc' }], 0, HOME_LIMIT),
  ]);
  return {
    featured: featured.map((r) => toCard(r, now)),
    endingSoon: endingSoon.map((r) => toCard(r, now)),
    upcoming: upcoming.map((r) => toCard(r, now)),
  };
}

export async function getCategoryNames(): Promise<string[]> {
  const raw = await getSetting('auction.categories');
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

export async function categoriesWithCounts(now = new Date()) {
  const [names, groups] = await Promise.all([
    getCategoryNames(),
    prisma.auction.groupBy({ by: ['category'], where: statusWhere('live', now), _count: { _all: true } }),
  ]);
  const counts = new Map(groups.map((g) => [g.category, g._count._all]));
  return names.map((name) => ({ name, liveCount: counts.get(name) ?? 0 }));
}

export async function getAuction(id: string, viewer: Actor | undefined, now = new Date()) {
  const row = (await prisma.auction.findUnique({ where: { id }, include: auctionInclude })) as AuctionRow | null;
  if (!row) throw auctionNotFound();
  const hidden = effectiveStatus(row, now) === 'CANCELLED';
  const privileged = !!viewer && (viewer.role === 'SUPER_ADMIN' || viewer.sub === row.sellerId);
  if (hidden && !privileged) throw auctionNotFound();
  return buildAuctionDetail(row, viewer?.sub ?? null, now);
}

const SITEMAP_MAX = 5000;
const SITEMAP_ENDED_DAYS = 90;

/** Live + upcoming + ended in the last 90 days (cancelled excluded), newest update first. */
export async function sitemapItems(now = new Date()) {
  const since = new Date(now.getTime() - SITEMAP_ENDED_DAYS * 24 * 60 * 60 * 1000);
  const rows = await prisma.auction.findMany({
    where: {
      deletedAt: null,
      status: { not: 'CANCELLED' },
      endTime: { gt: since }, // covers live + upcoming + ended in the window
    },
    select: { id: true, updatedAt: true },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    take: SITEMAP_MAX,
  });
  return { items: rows.map((r) => ({ id: r.id, updatedAt: r.updatedAt.toISOString() })) };
}

export async function listMine(sellerId: string, q: MineQuery, now = new Date()) {
  const where = { AND: [{ sellerId }, statusWhere(q.status, now)] };
  const { skip, take } = offsetArgs(q);
  const [rows, total] = await Promise.all([
    fetchCards(where, orderFor(q.status === 'upcoming' || q.status === 'live' ? 'live' : 'ended'), skip, take),
    prisma.auction.count({ where }),
  ]);
  return { items: rows.map((r) => toCard(r, now)), meta: pageMeta(total, q) };
}

// ---------------------------------------------------------------- writes

async function assertCategory(category: string) {
  const names = await getCategoryNames();
  if (!names.includes(category)) throw invalid('category must be one of the configured categories');
}

function cleanDescription(html: string) {
  const clean = sanitizeDescription(html);
  if (clean.length < 20) throw invalid('description must contain at least 20 characters of allowed content');
  return clean;
}

export async function createAuction(memberId: string, input: CreateAuctionInput, now = new Date()) {
  const member = await prisma.member.findUnique({ where: { id: memberId }, select: { unpaidCommissionPaise: true } });
  if (!member) throw new AppError(401, 'UNAUTHORIZED', 'Unauthorized');
  if (toPaise(member.unpaidCommissionPaise) > 0) {
    throw new AppError(403, 'COMMISSION_UNPAID', 'Pay your outstanding commission before listing new auctions');
  }
  await assertCategory(input.category);
  const timeError = checkTimeWindow(input.startTime, input.endTime, now);
  if (timeError) throw invalid(timeError);
  const maxPaise = await getMaxPricePaise();
  assertWithinMaxPrice(maxPaise, input.startingBidPaise, input.minIncrementPaise);

  let minIncrementPaise = input.minIncrementPaise;
  if (minIncrementPaise === undefined) {
    const setting = Number.parseInt((await getSetting('auction.minIncrementPaise')) ?? '', 10);
    minIncrementPaise = Number.isFinite(setting) && setting >= 100 ? setting : DEFAULT_MIN_INCREMENT_PAISE;
  }
  assertWithinMaxPrice(maxPaise, minIncrementPaise);

  const row = await prisma.auction.create({
    data: {
      title: input.title,
      description: cleanDescription(input.description),
      category: input.category,
      condition: input.condition,
      images: input.images,
      startingBidPaise: input.startingBidPaise,
      minIncrementPaise,
      startTime: input.startTime,
      endTime: input.endTime,
      status: input.startTime.getTime() <= now.getTime() ? 'LIVE' : 'SCHEDULED',
      sellerId: memberId,
    },
    include: auctionInclude,
  });
  return toDetail(row as AuctionRow, now);
}

// Non-owners get 404 (never reveal that the auction exists).
async function findOwned(id: string, actor: Actor): Promise<AuctionRow> {
  const row = (await prisma.auction.findUnique({ where: { id }, include: auctionInclude })) as AuctionRow | null;
  if (!row || row.sellerId !== actor.sub) throw auctionNotFound();
  return row;
}

export async function updateAuction(id: string, actor: Actor, input: UpdateAuctionInput, now = new Date()) {
  const existing = await findOwned(id, actor);
  if (existing.bidCount > 0) throw hasBids();
  if (['ENDED', 'CANCELLED'].includes(effectiveStatus(existing, now))) throw ended();

  if (input.category !== undefined) await assertCategory(input.category);
  if (input.startingBidPaise !== undefined || input.minIncrementPaise !== undefined) {
    assertWithinMaxPrice(await getMaxPricePaise(), input.startingBidPaise, input.minIncrementPaise);
  }

  const timesChanged = input.startTime !== undefined || input.endTime !== undefined;
  const start = input.startTime ?? existing.startTime;
  const end = input.endTime ?? existing.endTime;
  if (timesChanged) {
    const timeError = checkTimeWindow(start, end, now, input.startTime !== undefined);
    if (timeError) throw invalid(timeError);
  }

  const data: Record<string, unknown> = {};
  for (const k of ['title', 'category', 'condition', 'images', 'startingBidPaise', 'minIncrementPaise'] as const) {
    if (input[k] !== undefined) data[k] = input[k];
  }
  if (input.description !== undefined) data.description = cleanDescription(input.description);
  if (timesChanged) {
    data.startTime = start;
    data.endTime = end;
    if (start.getTime() > now.getTime()) data.status = 'SCHEDULED';
  }

  // bidCount: 0 in the WHERE closes the race with a bid landing after the check above.
  const { count } = await prisma.auction.updateMany({ where: { id, bidCount: 0, deletedAt: null }, data });
  if (count === 0) throw hasBids();
  if (timesChanged) await resetEndingSoon(id);
  const row = (await prisma.auction.findUnique({ where: { id }, include: auctionInclude })) as AuctionRow;
  return toDetail(row, now);
}

export async function deleteAuction(id: string, actor: Actor, now = new Date()) {
  const row = (await prisma.auction.findUnique({ where: { id }, select: { sellerId: true, bidCount: true, deletedAt: true } }));
  const isAdmin = actor.role === 'SUPER_ADMIN';
  if (!row || row.deletedAt || (!isAdmin && row.sellerId !== actor.sub)) throw auctionNotFound();
  if (!isAdmin && row.bidCount > 0) throw hasBids();

  const data = { status: 'CANCELLED' as const, deletedAt: now };
  if (isAdmin) {
    await prisma.auction.update({ where: { id }, data });
    if (row.bidCount > 0) logger.info({ auctionId: id, adminId: actor.sub, bidCount: row.bidCount }, 'auction cancelled by admin with bids');
  } else {
    const { count } = await prisma.auction.updateMany({ where: { id, bidCount: 0 }, data });
    if (count === 0) throw hasBids();
  }
  return { id };
}

export async function republishAuction(
  id: string,
  actor: Actor,
  input: { startTime: Date; endTime: Date },
  now = new Date(),
) {
  const existing = await findOwned(id, actor);
  if (effectiveStatus(existing, now) !== 'ENDED' || existing.bidCount > 0) {
    throw new AppError(
      409,
      'AUCTION_NOT_REPUBLISHABLE',
      'Only ended auctions with no bids can be republished',
    );
  }
  const timeError = checkTimeWindow(input.startTime, input.endTime, now);
  if (timeError) throw invalid(timeError);

  const { count } = await prisma.auction.updateMany({
    where: { id, bidCount: 0, deletedAt: null },
    data: {
      status: input.startTime.getTime() <= now.getTime() ? 'LIVE' : 'SCHEDULED',
      startTime: input.startTime,
      endTime: input.endTime,
      endedAt: null,
      winnerId: null,
      highestBidderId: null,
    },
  });
  if (count === 0) {
    throw new AppError(409, 'AUCTION_NOT_REPUBLISHABLE', 'Only ended auctions with no bids can be republished');
  }
  await resetEndingSoon(id);
  const row = (await prisma.auction.findUnique({ where: { id }, include: auctionInclude })) as AuctionRow;
  return toDetail(row, now);
}
