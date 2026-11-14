import { Router } from 'express';
import { prisma } from '@/core/prisma/client';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireRole } from '@/core/middleware/auth';

// Inline handlers lazy-load response helpers via dynamic import() (Lambda cold
// start). The prisma singleton stays a static import (container-cached).

const router = Router();
router.use(authenticate, requireRole('SUPER_ADMIN'));

// Aggregate dashboard metrics. TODO(Phase 2+): auction / bid / commission stats.
router.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    const { ok } = await import('@/core/http/response');
    const [byRole, active, revenue] = await Promise.all([
      prisma.member.groupBy({ by: ['role'], _count: true }),
      prisma.member.count({ where: { isActive: true } }),
      prisma.paymentOrder.aggregate({ where: { status: 'PAID' }, _sum: { amountPaise: true } }),
    ]);
    const roles: Record<string, number> = {};
    for (const r of byRole) roles[r.role] = r._count;

    return ok(res, {
      members: {
        total: Object.values(roles).reduce((a, b) => a + b, 0),
        active,
        bidders: roles.BIDDER ?? 0,
        auctioneers: roles.AUCTIONEER ?? 0,
      },
      revenuePaise: revenue._sum.amountPaise ?? 0,
    });
  }),
);

export default router;
