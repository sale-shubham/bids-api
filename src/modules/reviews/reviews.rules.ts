import { bidderLabel } from '@/modules/auctions/bidding.rules';

export const REVIEW_WINDOW_DAYS = 60;
const DAY_MS = 86_400_000;

export type ReviewDTO = {
  id: string;
  auctionId: string;
  auctionTitle: string;
  rating: number;
  comment: string | null;
  sellerReply: string | null;
  sellerRepliedAt: string | null;
  createdAt: string;
  reviewerLabel: string;
};

export type ReviewRow = {
  id: string;
  auctionId: string;
  rating: number;
  comment: string | null;
  sellerReply: string | null;
  sellerRepliedAt: Date | null;
  createdAt: Date;
  auction: { title: string };
  reviewer: { name: string };
};

export const reviewInclude = { auction: { select: { title: true } }, reviewer: { select: { name: true } } } as const;

/** Mean rating rounded to one decimal, or null when there are no counted reviews. */
export function ratingAvg(sum: number, count: number): number | null {
  if (!count || count <= 0) return null;
  return Math.round((sum / count) * 10) / 10;
}

type ReviewableAuction = {
  status: 'SCHEDULED' | 'LIVE' | 'ENDED' | 'CANCELLED';
  deletedAt: Date | null;
  startTime: Date;
  endTime: Date;
  winnerId: string | null;
  endedAt: Date | null;
};

/** Only the stamped winner of an ended auction, within 60 days of it ending. Review-exists is checked separately. */
export function isReviewWindowOpen(a: ReviewableAuction, viewerId: string | null | undefined, now: Date): boolean {
  if (!viewerId || a.winnerId !== viewerId || !a.endedAt) return false;
  if (a.status === 'CANCELLED' || a.deletedAt) return false;
  if (a.status !== 'ENDED' && now.getTime() < a.endTime.getTime()) return false;
  return now.getTime() - a.endedAt.getTime() <= REVIEW_WINDOW_DAYS * DAY_MS;
}

export function toReviewDTO(r: ReviewRow): ReviewDTO {
  return {
    id: r.id,
    auctionId: r.auctionId,
    auctionTitle: r.auction.title,
    rating: r.rating,
    comment: r.comment,
    sellerReply: r.sellerReply,
    sellerRepliedAt: r.sellerRepliedAt ? r.sellerRepliedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    reviewerLabel: bidderLabel(r.reviewer.name),
  };
}
