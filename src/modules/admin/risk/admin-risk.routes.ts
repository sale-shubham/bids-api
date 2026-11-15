import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireRole } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';
import { param } from '@/core/http/params';
import { listRiskQuery, reviewRiskBody } from './admin-risk.validation';

// Mounted at /admin/risk - SUPER_ADMIN only.
const router = Router();
router.use(authenticate, requireRole('SUPER_ADMIN'));

// GET /admin/risk?status=open|reviewed&page&pageSize -> paginated signals
router.get(
  '/',
  validate(listRiskQuery, 'query'),
  asyncHandler(async (req, res) => {
    const { paginated } = await import('@/core/http/response');
    const svc = await import('./admin-risk.service');
    const { items, meta } = await svc.listRisk(req.query as never);
    return paginated(res, items, meta);
  }),
);

// PATCH /admin/risk/:id { outcome, note? } -> { signal }
router.patch(
  '/:id',
  validate(reviewRiskBody),
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const svc = await import('./admin-risk.service');
    return ok(res, await svc.reviewSignal(param(req, 'id'), req.user!.sub, req.body));
  }),
);

export default router;
