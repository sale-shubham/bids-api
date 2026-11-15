import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireRole } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';
import { param } from '@/core/http/params';
import { createCategorySchema, updateCategorySchema } from '@/modules/categories/categories.validation';

// Mounted at /admin/categories — SUPER_ADMIN only.
const router = Router();
router.use(authenticate, requireRole('SUPER_ADMIN'));

// GET /admin/categories -> { items } flat list incl. inactive, with auctionCount
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const { ok } = await import('@/core/http/response');
    const svc = await import('@/modules/categories/categories.service');
    return ok(res, await svc.adminListCategories());
  }),
);

router.post(
  '/',
  validate(createCategorySchema),
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const svc = await import('@/modules/categories/categories.service');
    return ok(res, await svc.adminCreateCategory(req.body), 201);
  }),
);

router.patch(
  '/:id',
  validate(updateCategorySchema),
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const svc = await import('@/modules/categories/categories.service');
    return ok(res, await svc.adminUpdateCategory(param(req, 'id'), req.body));
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const svc = await import('@/modules/categories/categories.service');
    return ok(res, await svc.adminDeleteCategory(param(req, 'id')));
  }),
);

export default router;
