import { Prisma } from '@prisma/client';
import { prisma } from '@/core/prisma/client';
import { AppError } from '@/core/errors/AppError';
import { logger } from '@/core/logger/logger';
import { offsetArgs, pageMeta } from '@/core/http/pagination';
import { buildAuctionDetail } from './auction-detail.service';
import { resetEndingSoon } from '@/modules/watchlist/watchlist.service';
import { getSetting } from '@/modules/settings/settings.service';
import {
  categoriesWithCounts as categoryCounts,
  categoryContext,
  resolveActiveCategory,
  resolveBrowseCategoryIds,
  SOLD_WINDOW_DAYS,
} from '@/modules/categories/categories.service';
import { validateAttributes, type AttributeDef } from '@/modules/categories/categories.rules';
import { assertEstimate, assertShipping, CONDITION_REPORT_MAX } from './listing.rules';
import { getCheckoutMode } from '@/modules/settings/checkout-mode';
import { assertWithinMaxPrice, getMaxPricePaise } from '@/modules/settings/max-price';
import { toPaise, toPaiseOrNull } from '@/core/money';
import { depositForStartingBid } from '@/modules/deposits/deposits.service';
import { enqueueNotification } from '@/modules/notify/notify.queue';
import { auctionInclude, effectiveStatus, toCard, toDetail, type AuctionRow } from './auctions.serializer';
import { effectivePrice, listWhere, orderFor, statusWhere } from './auctions.query';
import {
  checkTimeWindow,
  createAuctionSchema,
  sanitizeDescription,
  type CreateAuctionInput,
  type ListQuery,
  type MineQuery,
  type UpdateAuctionInput,
} from './auctions.validation';

const DEFAULT_MIN_INCREMENT_PAISE = 10_000;
const HOME_LIMIT = 8;
const SIMILAR_LIMIT = 6;

type Actor = { sub: string; role: 'BIDDER' | 'AUCTIONEER' | 'SUPER_ADMIN' };

export const auctionNotFound = () => new AppError(404, 'AUCTION_NOT_FOUND', 'Auction not found');
const hasBids = () => new AppError(409, 'AUCTION_HAS_BIDS', 'This auction already has bids');
const ended = () => new AppError(409, 'AUCTION_ENDED', 'This auction has ended or was cancelled');
const invalid = (message: string) =>
  new AppError(400, 'VALIDATION_ERROR', message, [{ field: '', message }]);

/** Owner-only extra: the hidden reserve. toCard / toDetail never carry it. */
const withReserve = <T extends object>(row: AuctionRow, dto: T) => ({
  ...dto,
  reservePricePaise: toPaiseOrNull(row.reservePricePaise),
});

/** Reserve >= starting bid; buy-now > starting bid and >= reserve; both within the admin ceiling. */
function assertReserveBuyNow(startPaise: number, reserve: number | null | undefined, buyNow: number | null | undefined) {
  if (reserve != null && reserve < startPaise) {
    throw new AppError(400, 'INVALID_RESERVE', 'Reserve price must be at least the starting bid');
  }
  if (buyNow != null && buyNow <= startPaise) {
    throw new AppError(400, 'INVALID_BUY_NOW', 'Buy It Now price must be higher than the starting bid');
  }
  if (reserve != null && buyNow != null && buyNow < reserve) {
    throw new AppError(400, 'INVALID_BUY_NOW', 'Buy It Now price must be at least the reserve price');
  }
}

// ---------------------------------------------------------------- reads

async function fetchCards(where: object, orderBy: object[], skip?: number, take?: number) {
  const rows = await prisma.auction.findMany({ where, orderBy, skip, take, include: auctionInclude });
  return rows as AuctionRow[];
}

export async function listAuctions(q: ListQuery, now = new Date()) {
  const categoryIds = q.category ? ((await resolveBrowseCategoryIds(q.category)) ?? undefined) : undefined;
  const where = listWhere(q, now, categoryIds);
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
    fetchCards(where, orderFor(q.sold ? 'ended' : q.status, q.sort), skip, take),
    prisma.auction.count({ where }),
  ]);
  return { items: rows.map((r) => toCard(r, now)), meta: pageMeta(total, paging) };
}

/** Live auctions with a running paid feature (soonest-expiring first), optionally within a category tree. */
async function fetchPromoted(now: Date, take: number, categoryIds?: string[]) {
  const live = statusWhere('live', now);
  const where = { AND: [live, { featuredUntil: { gt: now } }, ...(categoryIds ? [{ categoryId: { in: categoryIds } }] : [])] };
  return fetchCards(where, [{ featuredUntil: 'asc' }, { id: 'asc' }], 0, take);
}

export async function homeFeed(now = new Date()) {
  const [promoted, mostBids, endingSoon, upcoming] = await Promise.all([
    fetchPromoted(now, HOME_LIMIT),
    fetchCards(statusWhere('live', now), [{ bidCount: 'desc' }, { endTime: 'asc' }, { id: 'asc' }], 0, HOME_LIMIT),
    fetchCards(statusWhere('live', now), [{ endTime: 'asc' }, { id: 'asc' }], 0, HOME_LIMIT),
    fetchCards(statusWhere('upcoming', now), [{ startTime: 'asc' }, { id: 'asc' }], 0, HOME_LIMIT),
  ]);
  // Paid placements first, then the most-bid live auctions fill the rest (no duplicates).
  const seen = new Set(promoted.map((r) => r.id));
  const featured = [...promoted, ...mostBids.filter((r) => !seen.has(r.id))].slice(0, HOME_LIMIT);
  return {
    featured: featured.map((r) => toCard(r, now)),
    endingSoon: endingSoon.map((r) => toCard(r, now)),
    upcoming: upcoming.map((r) => toCard(r, now)),
  };
}

/** GET /auctions/promoted: live promoted auctions, category incl. descendants. */
export async function promotedAuctions(q: { category?: string; limit: number }, now = new Date()) {
  const categoryIds = q.category ? await resolveBrowseCategoryIds(q.category) : undefined;
  if (q.category && !categoryIds) return { items: [] };
  const rows = await fetchPromoted(now, q.limit, categoryIds ?? undefined);
  return { items: rows.map((r) => toCard(r, now)) };
}

export const categoriesWithCounts = categoryCounts;

export async function getAuction(id: string, viewer: Actor | undefined, now = new Date()) {
  const row = (await prisma.auction.findUnique({ where: { id }, include: auctionInclude })) as AuctionRow | null;
  if (!row) throw auctionNotFound();
  const hidden = effectiveStatus(row, now) === 'CANCELLED';
  const privileged = !!viewer && (viewer.role === 'SUPER_ADMIN' || viewer.sub === row.sellerId);
  if (hidden && !privileged) throw auctionNotFound();
  return buildAuctionDetail(row, viewer?.sub ?? null, now, prisma, viewer?.role ?? null);
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

/** Up to 6 sold lots of the same category that ended in the last 90 days, newest first. */
export async function similarSold(id: string, now = new Date()) {
  const a = await prisma.auction.findUnique({ where: { id }, select: { id: true, categoryId: true, status: true, deletedAt: true } });
  if (!a || a.deletedAt || a.status === 'CANCELLED') throw auctionNotFound();
  if (!a.categoryId) return { items: [] };
  const since = new Date(now.getTime() - SOLD_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rows = await fetchCards(
    {
      AND: [statusWhere('ended', now), { winnerId: { not: null } }, { categoryId: a.categoryId }, { id: { not: id } }, { endedAt: { gte: since } }],
    },
    [{ endedAt: 'desc' }, { id: 'asc' }],
    0,
    SIMILAR_LIMIT,
  );
  return { items: rows.map((r) => toCard(r, now)) };
}

export async function listMine(sellerId: string, q: MineQuery, now = new Date()) {
  const where = { AND: [{ sellerId }, statusWhere(q.status, now)] };
  const { skip, take } = offsetArgs(q);
  const [rows, total] = await Promise.all([
    fetchCards(where, orderFor(q.status === 'upcoming' || q.status === 'live' ? 'live' : 'ended'), skip, take),
    prisma.auction.count({ where }),
  ]);
  return { items: rows.map((r) => withReserve(r, toCard(r, now))), meta: pageMeta(total, q) };
}

// ---------------------------------------------------------------- writes

/** Best-effort saved-search alerts for a newly published auction; never fails the request. */
async function notifySavedSearches(row: AuctionRow) {
  try {
    const { onAuctionPublished } = await import('@/modules/saved-searches/saved-search.matcher');
    await onAuctionPublished({
      id: row.id,
      title: row.title,
      category: row.category,
      categoryId: row.categoryId,
      condition: row.condition,
      startingBidPaise: toPaise(row.startingBidPaise),
      sellerId: row.sellerId,
    });
  } catch (err) {
    logger.error({ err, auctionId: row.id }, 'saved-search: matcher failed');
  }
}

function cleanDescription(html: string) {
  const clean = sanitizeDescription(html);
  if (clean.length < 20) throw invalid('description must contain at least 20 characters of allowed content');
  return clean;
}

/** Sanitised condition report (null when empty); at most 5,000 characters after sanitising. */
function cleanReport(html: string | null | undefined): string | null {
  if (!html) return null;
  const clean = sanitizeDescription(html);
  if (clean.length > CONDITION_REPORT_MAX) throw invalid(`conditionReport must be at most ${CONDITION_REPORT_MAX} characters`);
  return clean || null;
}

/** validateAttributes against the category schema; an empty result is stored as null. */
function checkedAttributes(schema: AttributeDef[], input: unknown): Record<string, string | number> | null {
  const r = validateAttributes(schema, input ?? {});
  if (!r.ok) throw new AppError(400, 'INVALID_ATTRIBUTES', 'Some attributes are invalid', { fields: r.fields });
  return Object.keys(r.value).length ? r.value : null;
}

const jsonOrNull = (v: object | null) => (v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue));

async function assertCanList(memberId: string) {
  const member = await prisma.member.findUnique({ where: { id: memberId }, select: { unpaidCommissionPaise: true } });
  if (!member) throw new AppError(401, 'UNAUTHORIZED', 'Unauthorized');
  if (toPaise(member.unpaidCommissionPaise) > 0) {
    throw new AppError(403, 'COMMISSION_UNPAID', 'Pay your outstanding commission before listing new auctions');
  }
  if ((await getCheckoutMode()) === 'required') {
    const payout = await prisma.sellerPayoutAccount.findUnique({ where: { sellerId: memberId }, select: { status: true } });
    if (payout?.status !== 'ACTIVE') throw new AppError(403, 'PAYOUT_ACCOUNT_REQUIRED', 'Set up payouts before listing');
  }
}

type CreateCtx = { maxPaise: number; defaultIncrement: number };

async function createContext(): Promise<CreateCtx> {
  const setting = Number.parseInt((await getSetting('auction.minIncrementPaise')) ?? '', 10);
  return {
    maxPaise: await getMaxPricePaise(),
    defaultIncrement: Number.isFinite(setting) && setting >= 100 ? setting : DEFAULT_MIN_INCREMENT_PAISE,
  };
}

/** Every create rule (category, attributes, prices, ceiling, times, estimate, report, shipping) -> the row data; throws AppError. */
async function prepareCreate(input: CreateAuctionInput, ctx: CreateCtx, now: Date) {
  const category = await resolveActiveCategory(input);
  const attributes = checkedAttributes(category.schema, input.attributes);
  const timeError = checkTimeWindow(input.startTime, input.endTime, now);
  if (timeError) throw invalid(timeError);
  assertWithinMaxPrice(ctx.maxPaise, input.startingBidPaise, input.minIncrementPaise);

  const minIncrementPaise = input.minIncrementPaise ?? ctx.defaultIncrement;
  assertWithinMaxPrice(ctx.maxPaise, minIncrementPaise, input.reservePricePaise ?? undefined, input.buyNowPricePaise ?? undefined);
  assertReserveBuyNow(input.startingBidPaise, input.reservePricePaise, input.buyNowPricePaise);
  assertEstimate(input.estimateLowPaise, input.estimateHighPaise, ctx.maxPaise);

  return {
    title: input.title,
    description: cleanDescription(input.description),
    category: category.name,
    categoryId: category.id,
    attributes: jsonOrNull(attributes),
    condition: input.condition,
    conditionReport: cleanReport(input.conditionReport),
    estimateLowPaise: input.estimateLowPaise ?? null,
    estimateHighPaise: input.estimateHighPaise ?? null,
    images: input.images,
    videoUrl: input.videoUrl ?? null,
    shippingOptions: jsonOrNull(input.shippingOptions ? assertShipping(input.shippingOptions) : null),
    startingBidPaise: input.startingBidPaise,
    minIncrementPaise,
    reservePricePaise: input.reservePricePaise ?? null,
    buyNowPricePaise: input.buyNowPricePaise ?? null,
    depositPaise: await depositForStartingBid(input.startingBidPaise),
    startTime: input.startTime,
    endTime: input.endTime,
    status: input.startTime.getTime() <= now.getTime() ? ('LIVE' as const) : ('SCHEDULED' as const),
  };
}

export async function createAuction(memberId: string, input: CreateAuctionInput, now = new Date()) {
  await assertCanList(memberId);
  const data = await prepareCreate(input, await createContext(), now);
  const row = (await prisma.auction.create({ data: { ...data, sellerId: memberId }, include: auctionInclude })) as AuctionRow;
  await notifySavedSearches(row);
  return withReserve(row, toDetail(row, now, await categoryContext(row.categoryId)));
}

type RowError = { field: string; message: string };

const CODE_FIELD: Record<string, string> = {
  INVALID_CATEGORY: 'categoryId',
  PRICE_TOO_HIGH: 'startingBidPaise',
  INVALID_RESERVE: 'reservePricePaise',
  INVALID_BUY_NOW: 'buyNowPricePaise',
};

function rowErrors(err: AppError): RowError[] {
  const d = err.details as { fields?: RowError[] } | RowError[] | undefined;
  if (Array.isArray(d) && d.length) return d;
  if (d && !Array.isArray(d) && Array.isArray(d.fields) && d.fields.length) return d.fields;
  return [{ field: CODE_FIELD[err.code] ?? '', message: err.message }];
}

/** All-or-nothing bulk create: every row is validated first (Joi + service rules); any failure -> 400 BULK_INVALID with per-row errors and nothing is written. */
export async function createAuctionsBulk(memberId: string, items: unknown[], now = new Date()) {
  await assertCanList(memberId);
  const ctx = await createContext();
  const failed: { index: number; errors: RowError[] }[] = [];
  const prepared: Awaited<ReturnType<typeof prepareCreate>>[] = [];
  for (const [index, raw] of items.entries()) {
    const { error, value } = createAuctionSchema.validate(raw, { abortEarly: false, convert: true, stripUnknown: true });
    if (error) {
      failed.push({ index, errors: error.details.map((d) => ({ field: d.path.join('.'), message: d.message.replace(/['"]/g, '') })) });
      continue;
    }
    try {
      prepared.push(await prepareCreate(value as CreateAuctionInput, ctx, now));
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      failed.push({ index, errors: rowErrors(err) });
    }
  }
  if (failed.length) throw new AppError(400, 'BULK_INVALID', `${failed.length} of ${items.length} items are invalid`, { rows: failed });

  const rows = await prisma.$transaction(async (tx) => {
    const out: AuctionRow[] = [];
    for (const data of prepared) out.push((await tx.auction.create({ data: { ...data, sellerId: memberId }, include: auctionInclude })) as AuctionRow);
    return out;
  });
  for (const row of rows) await notifySavedSearches(row);
  return { items: rows.map((r) => toCard(r, now)) };
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

  const data: Record<string, unknown> = {};
  const categoryChanged = input.categoryId !== undefined || input.category !== undefined;
  const newCategory = categoryChanged ? await resolveActiveCategory(input) : null;
  if (newCategory) {
    data.categoryId = newCategory.id;
    data.category = newCategory.name;
  }
  if (newCategory || input.attributes !== undefined) {
    const schema = newCategory ? newCategory.schema : (await categoryContext(existing.categoryId)).schema;
    const attrs = input.attributes !== undefined ? input.attributes : existing.attributes;
    data.attributes = jsonOrNull(checkedAttributes(schema, attrs));
  }
  if (input.estimateLowPaise !== undefined || input.estimateHighPaise !== undefined) {
    const low = input.estimateLowPaise !== undefined ? input.estimateLowPaise : toPaiseOrNull(existing.estimateLowPaise);
    const high = input.estimateHighPaise !== undefined ? input.estimateHighPaise : toPaiseOrNull(existing.estimateHighPaise);
    assertEstimate(low, high, await getMaxPricePaise());
    data.estimateLowPaise = low;
    data.estimateHighPaise = high;
  }
  if (input.conditionReport !== undefined) data.conditionReport = cleanReport(input.conditionReport);
  if (input.shippingOptions !== undefined) data.shippingOptions = jsonOrNull(input.shippingOptions ? assertShipping(input.shippingOptions) : null);
  if (input.startingBidPaise !== undefined || input.minIncrementPaise !== undefined) {
    assertWithinMaxPrice(await getMaxPricePaise(), input.startingBidPaise, input.minIncrementPaise);
  }

  const priceTouched =
    input.startingBidPaise !== undefined || input.reservePricePaise !== undefined || input.buyNowPricePaise !== undefined;
  if (priceTouched) {
    const reserve = input.reservePricePaise !== undefined ? input.reservePricePaise : toPaiseOrNull(existing.reservePricePaise);
    const buyNow = input.buyNowPricePaise !== undefined ? input.buyNowPricePaise : toPaiseOrNull(existing.buyNowPricePaise);
    assertWithinMaxPrice(await getMaxPricePaise(), reserve ?? undefined, buyNow ?? undefined);
    assertReserveBuyNow(input.startingBidPaise ?? toPaise(existing.startingBidPaise), reserve, buyNow);
  }

  const timesChanged = input.startTime !== undefined || input.endTime !== undefined;
  const start = input.startTime ?? existing.startTime;
  const end = input.endTime ?? existing.endTime;
  if (timesChanged) {
    const timeError = checkTimeWindow(start, end, now, input.startTime !== undefined);
    if (timeError) throw invalid(timeError);
  }

  for (const k of ['title', 'condition', 'images', 'videoUrl', 'startingBidPaise', 'minIncrementPaise', 'reservePricePaise', 'buyNowPricePaise'] as const) {
    if (input[k] !== undefined) data[k] = input[k];
  }
  if (input.description !== undefined) data.description = cleanDescription(input.description);
  // The deposit follows the starting bid (an admin override is replaced when the starting bid is edited).
  if (input.startingBidPaise !== undefined) data.depositPaise = await depositForStartingBid(input.startingBidPaise);
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
  return withReserve(row, toDetail(row, now, await categoryContext(row.categoryId)));
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
  await notifyCancelled(id, row.sellerId, actor.sub);
  return { id };
}

/**
 * Best effort, after the cancel committed: every distinct bidder and every HELD-deposit
 * holder is told the auction was cancelled (deposit holders: refunded automatically by the
 * deposit job). An admin cancel also tells the seller. Never throws.
 */
async function notifyCancelled(auctionId: string, sellerId: string, actorId: string) {
  try {
    const [bids, deposits] = await Promise.all([
      prisma.bid.findMany({ where: { auctionId }, select: { bidderId: true }, distinct: ['bidderId'] }),
      prisma.auctionDeposit.findMany({ where: { auctionId, status: 'HELD' }, select: { memberId: true } }),
    ]);
    const depositors = new Set(deposits.map((d) => d.memberId));
    const recipients = new Set<string>([...bids.map((b) => b.bidderId), ...depositors]);
    recipients.delete(sellerId);
    for (const memberId of recipients) {
      await enqueueNotification({
        type: 'auction-cancelled',
        memberId,
        auctionId,
        data: { audience: 'bidder', deposit: depositors.has(memberId) },
        dedupeKey: `auction-cancelled:${auctionId}:${memberId}`,
      });
    }
    if (actorId !== sellerId) {
      await enqueueNotification({
        type: 'auction-cancelled',
        memberId: sellerId,
        auctionId,
        data: { audience: 'seller' },
        dedupeKey: `auction-cancelled:${auctionId}:${sellerId}`,
      });
    }
  } catch (err) {
    logger.warn({ err, auctionId }, 'auction cancel: notifications failed');
  }
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
  await notifySavedSearches(row);
  return withReserve(row, toDetail(row, now, await categoryContext(row.categoryId)));
}
