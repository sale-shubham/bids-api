import type { Prisma } from '@prisma/client';
import { prisma } from '@/core/prisma/client';
import { offsetArgs, pageMeta } from '@/core/http/pagination';
import { AppError } from '@/core/errors/AppError';

// Backs the admin shill-bid review queue. Signals are flags only: acting on one (cancel auction, suspend member)
// uses the existing admin endpoints; this records the outcome.

const person = { select: { id: true, name: true, email: true } } as const;
const include = { auction: { select: { id: true, title: true } }, bidder: person, seller: person } as const;

type Row = Prisma.ShillSignalGetPayload<{ include: typeof include }>;

export function toRiskDTO(r: Row) {
  return {
    id: r.id,
    auction: { id: r.auction.id, title: r.auction.title },
    bidder: { id: r.bidder.id, name: r.bidder.name, email: r.bidder.email },
    seller: { id: r.seller.id, name: r.seller.name, email: r.seller.email },
    score: r.score,
    reasons: Array.isArray(r.reasons) ? (r.reasons as string[]) : [],
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    reviewedAt: r.reviewedAt,
    outcome: r.outcome,
    note: r.note,
  };
}

/** open = not reviewed yet, highest score first; reviewed = most recently reviewed first. */
export async function listRisk(q: { status: 'open' | 'reviewed'; page: number; pageSize: number }) {
  const open = q.status === 'open';
  const where: Prisma.ShillSignalWhereInput = { reviewedAt: open ? null : { not: null } };
  const orderBy: Prisma.ShillSignalOrderByWithRelationInput[] = open
    ? [{ score: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }]
    : [{ reviewedAt: 'desc' }, { id: 'asc' }];
  const [rows, total] = await Promise.all([
    prisma.shillSignal.findMany({ where, orderBy, include, ...offsetArgs(q) }),
    prisma.shillSignal.count({ where }),
  ]);
  return { items: (rows as Row[]).map(toRiskDTO), meta: pageMeta(total, q) };
}

export async function reviewSignal(
  id: string,
  adminId: string,
  input: { outcome: 'DISMISSED' | 'ACTION_TAKEN'; note?: string },
  now = new Date(),
) {
  const existing = await prisma.shillSignal.findUnique({ where: { id }, select: { id: true, reviewedAt: true } });
  if (!existing) throw new AppError(404, 'RISK_SIGNAL_NOT_FOUND', 'Risk signal not found');
  if (existing.reviewedAt) throw new AppError(409, 'RISK_ALREADY_REVIEWED', 'This signal was already reviewed');
  const { count } = await prisma.shillSignal.updateMany({
    where: { id, reviewedAt: null },
    data: { reviewedAt: now, reviewedById: adminId, outcome: input.outcome, note: input.note || null },
  });
  if (count === 0) throw new AppError(409, 'RISK_ALREADY_REVIEWED', 'This signal was already reviewed');
  const row = (await prisma.shillSignal.findUniqueOrThrow({ where: { id }, include })) as Row;
  return { signal: toRiskDTO(row) };
}
