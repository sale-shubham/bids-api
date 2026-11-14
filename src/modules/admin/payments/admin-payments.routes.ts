import { Router } from 'express';
import Joi from 'joi';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireRole } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';

// Mounted at /admin/payments — SUPER_ADMIN only, read-only.
const router = Router();
router.use(authenticate, requireRole('SUPER_ADMIN'));

const listQuerySchema = Joi.object({
  status: Joi.string().valid('created', 'paid', 'failed'),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(20),
});

// GET /admin/payments?status=&page=&pageSize=
router.get(
  '/',
  validate(listQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { paginated } = await import('@/core/http/response');
    const svc = await import('./admin-payments.service');
    const { items, meta } = await svc.listPayments(req.query as any);
    return paginated(res, items, meta);
  }),
);

export default router;
