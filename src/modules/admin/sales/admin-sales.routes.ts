import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireRole } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';
import { param } from '@/core/http/params';
import { adminListQuerySchema, pageSizeOf, refundSchema, type SaleListQuery } from '@/modules/sales/sales.validation';
import type { SaleStatus } from '@/modules/sales/sales.rules';

// Mounted at /admin/sales — SUPER_ADMIN only.
const router = Router();
router.use(authenticate, requireRole('SUPER_ADMIN'));

// GET /admin/sales?status=&q=&page=&limit= -> paginated SaleDTO (role ADMIN) with buyer / seller emails
router.get(
  '/',
  validate(adminListQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { paginated } = await import('@/core/http/response');
    const svc = await import('./admin-sales.service');
    const q = req.query as unknown as SaleListQuery & { status?: SaleStatus; q?: string };
    const { items, meta } = await svc.listSales({ status: q.status, q: q.q, page: q.page, pageSize: pageSizeOf(q) });
    return paginated(res, items, meta);
  }),
);

// POST /admin/sales/:id/release -> { sale }   (409 SALE_INVALID_STATE, 502 RELEASE_FAILED)
router.post(
  '/:id/release',
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const svc = await import('./admin-sales.service');
    return ok(res, { sale: await svc.adminRelease(param(req, 'id'), req.user!.sub) });
  }),
);

// POST /admin/sales/:id/refund { note? } -> { sale }   (409 SALE_INVALID_STATE)
router.post(
  '/:id/refund',
  validate(refundSchema),
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const svc = await import('./admin-sales.service');
    return ok(res, { sale: await svc.adminRefund(param(req, 'id'), req.user!.sub, req.body.note || undefined) });
  }),
);

export default router;
