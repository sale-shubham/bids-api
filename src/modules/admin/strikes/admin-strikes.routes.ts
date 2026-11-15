import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireRole } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';
import { param } from '@/core/http/params';
import { removeStrikeBody } from '@/modules/strikes/strikes.validation';

// Mounted at /admin/strikes - SUPER_ADMIN only.
const router = Router();
router.use(authenticate, requireRole('SUPER_ADMIN'));

// POST /admin/strikes/:id/remove { note? } -> { strike }
router.post(
  '/:id/remove',
  validate(removeStrikeBody),
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const svc = await import('@/modules/strikes/strikes.service');
    return ok(res, await svc.removeStrike(param(req, 'id'), req.user!.sub, req.body.note));
  }),
);

export default router;
