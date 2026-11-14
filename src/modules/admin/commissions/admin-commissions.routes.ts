import { Router } from 'express';
import Joi from 'joi';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireRole } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';
import { param } from '@/core/http/params';

// Mounted at /admin/commissions — SUPER_ADMIN only.
const router = Router();
router.use(authenticate, requireRole('SUPER_ADMIN'));

const listQuerySchema = Joi.object({
  status: Joi.string().valid('due', 'paid', 'waived', 'all').default('due'),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(20),
});

// GET /admin/commissions?status=&page=&pageSize= -> paginated CommissionDTO & { seller: { id, name, email } }
router.get(
  '/',
  validate(listQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { paginated } = await import('@/core/http/response');
    const svc = await import('@/modules/commissions/commissions.service');
    const { items, meta } = await svc.listAll(req.query as any);
    return paginated(res, items, meta);
  }),
);

// POST /admin/commissions/:id/waive -> { commission }   (409 COMMISSION_NOT_DUE)
router.post(
  '/:id/waive',
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const svc = await import('@/modules/commissions/commissions.service');
    return ok(res, { commission: await svc.waiveCommission(param(req, 'id'), req.user!.sub) });
  }),
);

export default router;
