import type { Prisma, ReportStatus, ReportTargetType } from '@prisma/client';
import { prisma } from '@/core/prisma/client';
import { offsetArgs, pageMeta } from '@/core/http/pagination';
import { AppError, NotFound } from '@/core/errors/AppError';

// Backs the admin moderation queue. Actions themselves (cancel auction, suspend member, hide review / question)
// use their existing endpoints; this only records the outcome.

export const HIGH_PRIORITY_THRESHOLD = 3;

export const priorityFor = (openCount: number): 'HIGH' | 'NORMAL' => (openCount >= HIGH_PRIORITY_THRESHOLD ? 'HIGH' : 'NORMAL');

const snippet = (v: string | null | undefined, fallback: string, max = 80) => {
  const t = (v ?? '').trim();
  if (!t) return fallback;
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
};

type TargetInfo = { label: string; url: string | null };
const REMOVED: TargetInfo = { label: '(removed)', url: null };

type Ref = { targetType: ReportTargetType; targetId: string };
const refKey = (r: Ref) => `${r.targetType}:${r.targetId}`;

/** Label + link for each reported target, fetched in one query per target type. */
async function loadTargets(refs: Ref[]): Promise<Map<string, TargetInfo>> {
  const ids = (t: ReportTargetType) => [...new Set(refs.filter((r) => r.targetType === t).map((r) => r.targetId))];
  const out = new Map<string, TargetInfo>();
  const [auctions, members, reviews, questions] = await Promise.all([
    ids('AUCTION').length ? prisma.auction.findMany({ where: { id: { in: ids('AUCTION') } }, select: { id: true, title: true } }) : [],
    ids('MEMBER').length ? prisma.member.findMany({ where: { id: { in: ids('MEMBER') } }, select: { id: true, name: true } }) : [],
    ids('REVIEW').length ? prisma.review.findMany({ where: { id: { in: ids('REVIEW') } }, select: { id: true, comment: true } }) : [],
    ids('QUESTION').length
      ? prisma.auctionQuestion.findMany({ where: { id: { in: ids('QUESTION') } }, select: { id: true, auctionId: true, question: true } })
      : [],
  ]);
  for (const a of auctions) out.set(`AUCTION:${a.id}`, { label: a.title, url: `/auctions/${a.id}` });
  for (const m of members) out.set(`MEMBER:${m.id}`, { label: m.name, url: `/sellers/${m.id}` });
  for (const r of reviews) out.set(`REVIEW:${r.id}`, { label: snippet(r.comment, 'Review'), url: '/admin/reviews' });
  for (const q of questions) out.set(`QUESTION:${q.id}`, { label: snippet(q.question, 'Question'), url: `/auctions/${q.auctionId}` });
  return out;
}

async function openCounts(refs: Ref[]): Promise<Map<string, number>> {
  if (!refs.length) return new Map();
  const rows = await prisma.report.groupBy({
    by: ['targetType', 'targetId'],
    where: { status: 'OPEN', OR: refs.map((r) => ({ targetType: r.targetType, targetId: r.targetId })) },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [refKey(r), r._count._all]));
}

export async function listReports(params: { status?: ReportStatus; targetType?: ReportTargetType; page: number; pageSize: number }) {
  const where: Prisma.ReportWhereInput = {
    ...(params.status ? { status: params.status } : {}),
    ...(params.targetType ? { targetType: params.targetType } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.report.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { reporter: { select: { id: true, name: true, email: true } } },
      ...offsetArgs(params),
    }),
    prisma.report.count({ where }),
  ]);
  const [targets, counts] = await Promise.all([loadTargets(rows), openCounts(rows)]);
  const items = rows.map((r) => {
    const openCountForTarget = counts.get(refKey(r)) ?? 0;
    return {
      id: r.id,
      targetType: r.targetType,
      targetId: r.targetId,
      reason: r.reason,
      details: r.details,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
      note: r.note,
      reporter: { id: r.reporter.id, name: r.reporter.name, email: r.reporter.email },
      target: targets.get(refKey(r)) ?? REMOVED,
      openCountForTarget,
      priority: priorityFor(openCountForTarget),
    };
  });
  return { items, meta: pageMeta(total, params) };
}

export async function resolveReport(
  id: string,
  adminId: string,
  input: { status: 'ACTION_TAKEN' | 'DISMISSED'; note?: string; applyToAllOpenForTarget?: boolean },
  now = new Date(),
) {
  const report = await prisma.report.findUnique({ where: { id }, select: { id: true, status: true, targetType: true, targetId: true } });
  if (!report) throw NotFound('Report not found');
  if (report.status !== 'OPEN') throw new AppError(409, 'REPORT_ALREADY_RESOLVED', 'This report was already resolved');

  const data = { status: input.status, resolvedById: adminId, resolvedAt: now, note: input.note || null };
  const { count } = await prisma.report.updateMany({
    where: input.applyToAllOpenForTarget
      ? { targetType: report.targetType, targetId: report.targetId, status: 'OPEN' }
      : { id, status: 'OPEN' },
    data,
  });
  return {
    report: { id, status: input.status, resolvedAt: now.toISOString(), note: data.note },
    resolvedCount: count,
  };
}
