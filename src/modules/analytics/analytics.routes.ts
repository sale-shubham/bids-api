import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireActiveMember, requireRole } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';
import { param } from '@/core/http/params';
import { rangeQuerySchema } from './analytics.validation';

// Mounted at /analytics — members (and super admins).
const router = Router();
router.use(authenticate, requireRole('MEMBER', 'SUPER_ADMIN'), requireActiveMember);

router.get(
  '/seller',
  validate(rangeQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const svc = await import('./analytics.service');
    return ok(res, await svc.sellerAnalytics(req.user!.sub, Number(req.query.days)));
  }),
);

router.get(
  '/auctions/:id',
  validate(rangeQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const svc = await import('./analytics.service');
    return ok(res, await svc.auctionAnalytics(param(req, 'id'), { id: req.user!.sub, role: req.user!.role }, Number(req.query.days)));
  }),
);

export default router;
