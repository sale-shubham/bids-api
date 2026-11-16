import { prisma } from '@/core/prisma/client';
import { AppError, Forbidden } from '@/core/errors/AppError';
import { offsetArgs, pageMeta } from '@/core/http/pagination';
import { enqueueNotification } from '@/modules/notify/notify.queue';
import { auctionNotFound } from '@/modules/auctions/auctions.service';
import { isReviewWindowOpen, reviewInclude, toReviewDTO } from './reviews.rules';

const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code === 'P2002';
const alreadyReviewed = () => new AppError(409, 'ALREADY_REVIEWED', 'You have already reviewed this auction');
export const reviewNotFound = () => new AppError(404, 'REVIEW_NOT_FOUND', 'Review not found');

export async function createReview(
  memberId: string,
  auctionId: string,
  input: { rating: number; comment?: string },
  now = new Date(),
) {
  const auction = await prisma.auction.findUnique({
    where: { id: auctionId },
    select: { id: true, sellerId: true, status: true, deletedAt: true, startTime: true, endTime: true, winnerId: true, endedAt: true },
  });
  if (!auction) throw auctionNotFound();
  const sale = await prisma.sale.findFirst({
    where: { auctionId },
    orderBy: { createdAt: 'desc' },
    select: { status: true, deliveredAt: true, releasedAt: true },
  });
  // Explicit: with one MEMBER role a seller is also a buyer, so never let them review their own auction.
  if (auction.sellerId === memberId) {
    throw new AppError(403, 'REVIEW_NOT_ALLOWED', 'You cannot review your own auction');
  }
  if (!isReviewWindowOpen(auction, memberId, now, sale)) {
    throw new AppError(403, 'REVIEW_NOT_ALLOWED', 'Only the winner of an ended auction can review the seller, within 60 days (after delivery when paid through checkout)');
  }
  if (await prisma.review.findUnique({ where: { auctionId }, select: { id: true } })) throw alreadyReviewed();

  let review;
  try {
    review = await prisma.$transaction(async (tx) => {
      const created = await tx.review.create({
        data: {
          auctionId,
          sellerId: auction.sellerId,
          reviewerId: memberId,
          rating: input.rating,
          comment: input.comment || null,
        },
        include: reviewInclude,
      });
      await tx.member.update({
        where: { id: auction.sellerId },
        data: { ratingCount: { increment: 1 }, ratingSum: { increment: input.rating } },
      });
      return created;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw alreadyReviewed();
    throw err;
  }

  await enqueueNotification({
    type: 'review-received',
    memberId: auction.sellerId,
    auctionId,
    data: { rating: input.rating, sellerId: auction.sellerId },
    dedupeKey: `review-received:${review.id}`,
  });
  return toReviewDTO(review);
}

export async function replyToReview(memberId: string, reviewId: string, reply: string, now = new Date()) {
  const review = await prisma.review.findUnique({ where: { id: reviewId }, select: { id: true, sellerId: true, sellerReply: true } });
  if (!review) throw reviewNotFound();
  if (review.sellerId !== memberId) throw Forbidden('Only the reviewed seller can reply');
  if (review.sellerReply) throw new AppError(409, 'ALREADY_REPLIED', 'You have already replied to this review');
  // sellerReply: null in the WHERE closes the race with a concurrent reply.
  const { count } = await prisma.review.updateMany({
    where: { id: reviewId, sellerReply: null },
    data: { sellerReply: reply, sellerRepliedAt: now },
  });
  if (count === 0) throw new AppError(409, 'ALREADY_REPLIED', 'You have already replied to this review');
  const row = await prisma.review.findUnique({ where: { id: reviewId }, include: reviewInclude });
  if (!row) throw reviewNotFound();
  return toReviewDTO(row);
}

/** Public, non-hidden reviews of a seller, newest first. */
export async function listSellerReviews(sellerId: string, paging: { page: number; pageSize: number }) {
  const where = { sellerId, hiddenAt: null };
  const [rows, total] = await Promise.all([
    prisma.review.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], include: reviewInclude, ...offsetArgs(paging) }),
    prisma.review.count({ where }),
  ]);
  return { items: rows.map(toReviewDTO), meta: pageMeta(total, paging) };
}
