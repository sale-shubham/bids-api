import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireActiveMember } from '@/core/middleware/auth';
import { param } from '@/core/http/params';

// Mounted at /sellers.
const router = Router();

router.post(
  '/:id/follow',
  authenticate,
  requireActiveMember,
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const svc = await import('./follows.service');
    return ok(res, await svc.followSeller(req.user!.sub, param(req, 'id')));
  }),
);

router.delete(
  '/:id/follow',
  authenticate,
  requireActiveMember,
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const svc = await import('./follows.service');
    return ok(res, await svc.unfollowSeller(req.user!.sub, param(req, 'id')));
  }),
);

export default router;
