import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => {
  const d: any = {
    auction: { findUnique: vi.fn() },
    review: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    member: { update: vi.fn() },
    sale: { findFirst: vi.fn() },
  };
  d.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(d));
  return d;
});
const enqueue = vi.hoisted(() => vi.fn(async (_m: unknown) => undefined));
vi.mock('@/core/prisma/client', () => ({ prisma: db }));
vi.mock('@/modules/notify/notify.queue', () => ({ enqueueNotification: enqueue }));
vi.mock('@/modules/auctions/auctions.service', async () => {
  const { AppError } = await import('@/core/errors/AppError');
  return { auctionNotFound: () => new AppError(404, 'AUCTION_NOT_FOUND', 'Auction not found') };
});

import { ratingAvg, isReviewWindowOpen, toReviewDTO } from './reviews.rules';
import { createReview, replyToReview } from './reviews.service';
import { setReviewHidden } from '@/modules/admin/reviews/admin-reviews.service';

const DAY = 86_400_000;
const now = new Date('2026-11-15T10:00:00Z');
const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => `${e.statusCode}:${e.code}`,
  );

const auction = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  sellerId: 's1',
  status: 'ENDED',
  deletedAt: null,
  startTime: new Date(now.getTime() - 10 * DAY),
  endTime: new Date(now.getTime() - 5 * DAY),
  winnerId: 'w1',
  endedAt: new Date(now.getTime() - 5 * DAY),
  ...over,
});
const reviewRow = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  auctionId: 'a1',
  rating: 4,
  comment: 'Good',
  sellerReply: null,
  sellerRepliedAt: null,
  createdAt: now,
  auction: { title: 'Watch' },
  reviewer: { name: 'Ramesh' },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  db.auction.findUnique.mockResolvedValue(auction());
  db.review.findUnique.mockResolvedValue(null);
  db.review.create.mockResolvedValue(reviewRow());
  db.sale.findFirst.mockResolvedValue(null);
});

describe('ratingAvg', () => {
  it('is null with no reviews and rounds to one decimal', () => {
    expect(ratingAvg(0, 0)).toBeNull();
    expect(ratingAvg(14, 3)).toBe(4.7);
    expect(ratingAvg(9, 2)).toBe(4.5);
    expect(ratingAvg(5, 1)).toBe(5);
  });
});

describe('isReviewWindowOpen', () => {
  it('needs the stamped winner, an ended auction and endedAt within 60 days', () => {
    expect(isReviewWindowOpen(auction() as never, 'w1', now)).toBe(true);
    expect(isReviewWindowOpen(auction() as never, 'x', now)).toBe(false);
    expect(isReviewWindowOpen(auction({ winnerId: null }) as never, 'w1', now)).toBe(false);
    expect(isReviewWindowOpen(auction({ endedAt: new Date(now.getTime() - 61 * DAY) }) as never, 'w1', now)).toBe(false);
    expect(isReviewWindowOpen(auction({ endedAt: new Date(now.getTime() - 60 * DAY) }) as never, 'w1', now)).toBe(true);
  });
});

describe('toReviewDTO', () => {
  it('masks the reviewer name', () => {
    expect(toReviewDTO(reviewRow() as never)).toMatchObject({ reviewerLabel: 'R***h', auctionTitle: 'Watch', sellerReply: null });
  });
});

describe('review eligibility with a checkout sale', () => {
  const sale = (status: string, over: Record<string, unknown> = {}) => ({ status, deliveredAt: null, releasedAt: null, ...over });
  it('needs the sale to be DELIVERED or RELEASED', () => {
    for (const s of ['AWAITING_PAYMENT', 'PAID', 'SHIPPED', 'DISPUTED', 'REFUNDED', 'CANCELLED']) {
      expect(isReviewWindowOpen(auction() as never, 'w1', now, sale(s, { deliveredAt: now }))).toBe(false);
    }
    expect(isReviewWindowOpen(auction() as never, 'w1', now, sale('DELIVERED', { deliveredAt: now }))).toBe(true);
    expect(isReviewWindowOpen(auction() as never, 'w1', now, sale('RELEASED', { deliveredAt: now }))).toBe(true);
  });
  it('counts the 60 days from deliveredAt, not from the auction end', () => {
    const old = auction({ endedAt: new Date(now.getTime() - 90 * DAY) });
    expect(isReviewWindowOpen(old as never, 'w1', now)).toBe(false); // legacy rule: window passed
    expect(isReviewWindowOpen(old as never, 'w1', now, sale('RELEASED', { deliveredAt: new Date(now.getTime() - 10 * DAY) }))).toBe(true);
    expect(isReviewWindowOpen(old as never, 'w1', now, sale('RELEASED', { deliveredAt: new Date(now.getTime() - 61 * DAY) }))).toBe(false);
  });
  it('falls back to releasedAt when released without a delivery, and rejects when neither is set', () => {
    expect(isReviewWindowOpen(auction() as never, 'w1', now, sale('RELEASED', { releasedAt: now }))).toBe(true);
    expect(isReviewWindowOpen(auction() as never, 'w1', now, sale('RELEASED'))).toBe(false);
  });
  it('createReview is blocked until the sale is delivered, allowed after', async () => {
    db.sale.findFirst.mockResolvedValue(sale('SHIPPED'));
    expect(await code(createReview('w1', 'a1', { rating: 5 }, now))).toBe('403:REVIEW_NOT_ALLOWED');
    db.sale.findFirst.mockResolvedValue(sale('DELIVERED', { deliveredAt: now }));
    expect(await code(createReview('w1', 'a1', { rating: 5 }, now))).toBe('ok');
  });
  it('legacy auctions without a Sale keep the current rule', () => {
    expect(isReviewWindowOpen(auction() as never, 'w1', now, null)).toBe(true);
  });
});

describe('createReview', () => {
  it('404 for an unknown auction', async () => {
    db.auction.findUnique.mockResolvedValue(null);
    expect(await code(createReview('w1', 'a1', { rating: 5 }, now))).toBe('404:AUCTION_NOT_FOUND');
  });
  it('403 when not the winner, not ended, or older than 60 days', async () => {
    expect(await code(createReview('other', 'a1', { rating: 5 }, now))).toBe('403:REVIEW_NOT_ALLOWED');
    db.auction.findUnique.mockResolvedValue(auction({ status: 'LIVE', endTime: new Date(now.getTime() + DAY), endedAt: null }));
    expect(await code(createReview('w1', 'a1', { rating: 5 }, now))).toBe('403:REVIEW_NOT_ALLOWED');
    db.auction.findUnique.mockResolvedValue(auction({ endedAt: new Date(now.getTime() - 61 * DAY) }));
    expect(await code(createReview('w1', 'a1', { rating: 5 }, now))).toBe('403:REVIEW_NOT_ALLOWED');
    expect(db.review.create).not.toHaveBeenCalled();
  });
  it('403 when the reviewer is the auction seller, even if stamped as winner', async () => {
    db.auction.findUnique.mockResolvedValue(auction({ winnerId: 's1' }));
    expect(await code(createReview('s1', 'a1', { rating: 5 }, now))).toBe('403:REVIEW_NOT_ALLOWED');
    expect(db.review.create).not.toHaveBeenCalled();
  });
  it('409 ALREADY_REVIEWED, also on the unique-violation race', async () => {
    db.review.findUnique.mockResolvedValue({ id: 'r0' });
    expect(await code(createReview('w1', 'a1', { rating: 5 }, now))).toBe('409:ALREADY_REVIEWED');
    db.review.findUnique.mockResolvedValue(null);
    db.review.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
    expect(await code(createReview('w1', 'a1', { rating: 5 }, now))).toBe('409:ALREADY_REVIEWED');
  });
  it('happy path creates the review, updates seller totals and notifies the seller', async () => {
    const dto = await createReview('w1', 'a1', { rating: 4, comment: 'Good' }, now);
    expect(dto).toMatchObject({ id: 'r1', rating: 4 });
    expect(db.review.create.mock.calls[0][0].data).toMatchObject({ auctionId: 'a1', sellerId: 's1', reviewerId: 'w1', rating: 4 });
    expect(db.member.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { ratingCount: { increment: 1 }, ratingSum: { increment: 4 } },
    });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'review-received', memberId: 's1', dedupeKey: 'review-received:r1' }),
    );
  });
});

describe('replyToReview', () => {
  beforeEach(() => {
    db.review.findUnique.mockResolvedValue({ id: 'r1', sellerId: 's1', sellerReply: null });
    db.review.updateMany.mockResolvedValue({ count: 1 });
  });
  it('only the reviewed seller, only once', async () => {
    expect(await code(replyToReview('x', 'r1', 'thanks', now))).toBe('403:FORBIDDEN');
    db.review.findUnique.mockResolvedValue({ id: 'r1', sellerId: 's1', sellerReply: 'already' });
    expect(await code(replyToReview('s1', 'r1', 'thanks', now))).toBe('409:ALREADY_REPLIED');
    db.review.findUnique.mockResolvedValue({ id: 'r1', sellerId: 's1', sellerReply: null });
    db.review.updateMany.mockResolvedValue({ count: 0 });
    expect(await code(replyToReview('s1', 'r1', 'thanks', now))).toBe('409:ALREADY_REPLIED');
  });
  it('stores the reply', async () => {
    db.review.findUnique
      .mockResolvedValueOnce({ id: 'r1', sellerId: 's1', sellerReply: null })
      .mockResolvedValueOnce(reviewRow({ sellerReply: 'thanks', sellerRepliedAt: now }));
    const dto = await replyToReview('s1', 'r1', 'thanks', now);
    expect(dto).toMatchObject({ sellerReply: 'thanks', sellerRepliedAt: now.toISOString() });
  });
});

describe('admin hide / unhide', () => {
  const adminRow = () => ({
    ...reviewRow(),
    hiddenAt: null,
    sellerId: 's1',
    reviewer: { id: 'w1', name: 'Ramesh', email: 'r@x.com' },
    seller: { id: 's1', name: 'Seller' },
  });
  beforeEach(() => {
    db.review.findUnique.mockResolvedValue(adminRow());
    db.review.updateMany.mockResolvedValue({ count: 1 });
  });
  it('hiding subtracts from the seller totals', async () => {
    await setReviewHidden('r1', true, now);
    expect(db.member.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { ratingCount: { increment: -1 }, ratingSum: { increment: -4 } },
    });
  });
  it('unhiding adds back', async () => {
    await setReviewHidden('r1', false, now);
    expect(db.member.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { ratingCount: { increment: 1 }, ratingSum: { increment: 4 } },
    });
  });
  it('is idempotent: a no-op update leaves the totals alone', async () => {
    db.review.updateMany.mockResolvedValue({ count: 0 });
    await setReviewHidden('r1', true, now);
    expect(db.member.update).not.toHaveBeenCalled();
  });
  it('404 for an unknown review', async () => {
    db.review.findUnique.mockResolvedValue(null);
    expect(await code(setReviewHidden('nope', true, now))).toBe('404:REVIEW_NOT_FOUND');
  });
});
