import { prisma } from '@/core/prisma/client';
import { logger } from '@/core/logger/logger';
import { AppError } from '@/core/errors/AppError';
import { enqueueNotification } from '@/modules/notify/notify.queue';
import type { CreateReportInput } from './reports.validation';

export const reportTargetNotFound = () => new AppError(404, 'REPORT_TARGET_NOT_FOUND', 'The reported item was not found');
export const invalidReport = () => new AppError(400, 'INVALID_REPORT', 'You cannot report your own account or content');
export const alreadyReported = () => new AppError(409, 'ALREADY_REPORTED', 'You have already reported this');

const snippet = (v: string | null | undefined, max = 80) => {
  const t = (v ?? '').trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
};

type Target = { ownerId: string | null; label: string };

// The reported thing must exist (and be visible); ownerId is who authored / owns it.
async function resolveTarget(type: CreateReportInput['targetType'], id: string): Promise<Target | null> {
  switch (type) {
    case 'AUCTION': {
      const a = await prisma.auction.findFirst({ where: { id, deletedAt: null }, select: { sellerId: true, title: true } });
      return a ? { ownerId: a.sellerId, label: snippet(a.title) } : null;
    }
    case 'MEMBER': {
      const m = await prisma.member.findFirst({ where: { id, isActive: true }, select: { id: true, name: true } });
      return m ? { ownerId: m.id, label: snippet(m.name) } : null;
    }
    case 'REVIEW': {
      const r = await prisma.review.findUnique({ where: { id }, select: { reviewerId: true, comment: true } });
      return r ? { ownerId: r.reviewerId, label: snippet(r.comment) || 'Review' } : null;
    }
    case 'QUESTION': {
      const q = await prisma.auctionQuestion.findUnique({ where: { id }, select: { askerId: true, question: true } });
      return q ? { ownerId: q.askerId, label: snippet(q.question) } : null;
    }
  }
}

const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code === 'P2002';

export async function createReport(reporterId: string, input: CreateReportInput) {
  const target = await resolveTarget(input.targetType, input.targetId);
  if (!target) throw reportTargetNotFound();
  if (target.ownerId === reporterId) throw invalidReport();

  let report: { id: string; status: string };
  try {
    report = await prisma.report.create({
      data: {
        reporterId,
        targetType: input.targetType,
        targetId: input.targetId,
        reason: input.reason,
        details: input.details || null,
      },
      select: { id: true, status: true },
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw alreadyReported();
    throw err;
  }

  await notifyAdmins(report.id, input, target.label);
  return { report };
}

// Best-effort: a notification problem must never fail the report itself.
async function notifyAdmins(reportId: string, input: CreateReportInput, targetLabel: string) {
  try {
    const admins = await prisma.member.findMany({ where: { role: 'SUPER_ADMIN', isActive: true }, select: { id: true } });
    await Promise.all(
      admins.map((a) =>
        enqueueNotification({
          type: 'report-filed',
          memberId: a.id,
          data: { reportId, targetType: input.targetType, reason: input.reason, targetLabel },
          dedupeKey: `report-filed:${reportId}:${a.id}`,
        }),
      ),
    );
  } catch (err) {
    logger.error({ err, reportId }, 'reports: admin notification failed');
  }
}
