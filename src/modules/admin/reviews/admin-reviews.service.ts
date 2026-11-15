import type { Prisma } from '@prisma/client';
import { prisma } from '@/core/prisma/client';
import { offsetArgs, pageMeta } from '@/core/http/pagination';
import { toReviewDTO, type ReviewRow } from '@/modules/reviews/reviews.rules';
import { reviewNotFound } from '@/modules/reviews/reviews.service';

const adminInclude = {
  auction: { select: { title: true } },
  reviewer: { select: { id: true, name: true, email: true } },
  seller: { select: { id: true, name: true } },
} satisfies Prisma.ReviewInclude;

type AdminRow = ReviewRow & {
  hiddenAt: Date | null;
  reviewer: { id: string; name: string; email: string };
  seller: { id: string; name: string };
};

export function toAdminReviewDTO(r: AdminRow) {
  return {
    ...toReviewDTO(r),
    hiddenAt: r.hiddenAt ? r.hiddenAt.toISOString() : null,
    reviewer: { id: r.reviewer.id, name: r.reviewer.name, email: r.reviewer.email },
    seller: { id: r.seller.id, name: r.seller.name },
  };
}

export async function listReviews(params: { hidden?: boolean; q?: string; page: number; pageSize: number }) {
  const search = params.q?.trim();
  const contains = (field: string) => ({ [field]: { contains: search, mode: 'insensitive' as const } });
  const where: Prisma.ReviewWhereInput = {
    ...(params.hidden === true ? { hiddenAt: { not: null } } : {}),
    ...(params.hidden === false ? { hiddenAt: null } : {}),
    ...(search
      ? {
          OR: [
            contains('comment'),
            { reviewer: contains('name') },
            { reviewer: contains('email') },
            { seller: contains('name') },
            { seller: contains('email') },
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.review.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], include: adminInclude, ...offsetArgs(params) }),
    prisma.review.count({ where }),
  ]);
  return { items: rows.map(toAdminReviewDTO), meta: pageMeta(total, params) };
}

/** Hiding removes the review from the seller's rating totals, unhiding adds it back. Idempotent. */
export async function setReviewHidden(id: string, hidden: boolean, now = new Date()) {
  const review = await prisma.review.findUnique({ where: { id }, select: { id: true, sellerId: true, rating: true } });
  if (!review) throw reviewNotFound();

  await prisma.$transaction(async (tx) => {
    // The guarded updateMany makes the count change only for the call that flips the state.
    const { count } = hidden
      ? await tx.review.updateMany({ where: { id, hiddenAt: null }, data: { hiddenAt: now } })
      : await tx.review.updateMany({ where: { id, hiddenAt: { not: null } }, data: { hiddenAt: null } });
    if (count === 0) return;
    const sign = hidden ? -1 : 1;
    await tx.member.update({
      where: { id: review.sellerId },
      data: { ratingCount: { increment: sign }, ratingSum: { increment: sign * review.rating } },
    });
  });

  const row = await prisma.review.findUnique({ where: { id }, include: adminInclude });
  if (!row) throw reviewNotFound();
  return toAdminReviewDTO(row);
}
