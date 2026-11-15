import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireActiveMember, requireRole } from '@/core/middleware/auth';
import { param } from '@/core/http/params';

// Mounted at /second-chance-offers - the runner-up (BIDDER) answers offers the seller made.
const router = Router();
const bidder = [authenticate, requireRole('BIDDER'), requireActiveMember];

router.get(
  '/mine',
  ...bidder,
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const svc = await import('./second-chance.service');
    return ok(res, await svc.listMine(req.user!.sub));
  }),
);

router.get(
  '/:id',
  ...bidder,
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const svc = await import('./second-chance.service');
    return ok(res, await svc.getOne(req.user!.sub, param(req, 'id')));
  }),
);

router.post(
  '/:id/accept',
  ...bidder,
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const svc = await import('./second-chance.service');
    return ok(res, await svc.acceptOffer(req.user!.sub, param(req, 'id')));
  }),
);

router.post(
  '/:id/decline',
  ...bidder,
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const svc = await import('./second-chance.service');
    return ok(res, await svc.declineOffer(req.user!.sub, param(req, 'id')));
  }),
);

export default router;
