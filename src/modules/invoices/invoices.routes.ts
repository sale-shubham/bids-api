import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireActiveMember, requireRole } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';
import { param } from '@/core/http/params';
import { adminListQuerySchema, mineQuerySchema, type AdminListQuery, type MineQuery } from './invoices.validation';

// GET /invoices/mine, GET /invoices/:id/pdf (owner or SUPER_ADMIN)
const router = Router();

router.get(
  '/mine',
  authenticate,
  requireActiveMember,
  validate(mineQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { paginated } = await import('@/core/http/response');
    const svc = await import('./invoices.service');
    const { items, meta } = await svc.listMine(req.user!.sub, req.query as unknown as MineQuery);
    return paginated(res, items, meta);
  }),
);

router.get(
  '/:id/pdf',
  authenticate,
  requireActiveMember,
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const svc = await import('./invoices.service');
    return ok(res, await svc.getPdfUrl({ sub: req.user!.sub, role: req.user!.role }, param(req, 'id')));
  }),
);

export default router;

// GET /admin/invoices?type=&q=&page&pageSize (SUPER_ADMIN)
export const adminInvoicesRouter = Router();
adminInvoicesRouter.use(authenticate, requireRole('SUPER_ADMIN'));
adminInvoicesRouter.get(
  '/',
  validate(adminListQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { paginated } = await import('@/core/http/response');
    const svc = await import('./invoices.service');
    const { items, meta } = await svc.listAll(req.query as unknown as AdminListQuery);
    return paginated(res, items, meta);
  }),
);
