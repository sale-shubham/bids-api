import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireActiveMember, requireRole } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';
import { param } from '@/core/http/params';
import { featureCheckoutSchema } from './featured.validation';

// Mounted inside the auctions router at /auctions/:id/feature
export const auctionFeatureRouter = Router({ mergeParams: true });
const seller = [authenticate, requireRole('MEMBER'), requireActiveMember];

auctionFeatureRouter.post(
  '/checkout',
  ...seller,
  validate(featureCheckoutSchema),
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const svc = await import('./featured.service');
    return ok(res, await svc.checkout(req.user!.sub, param(req, 'id'), req.body));
  }),
);

auctionFeatureRouter.get(
  '/',
  ...seller,
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const svc = await import('./featured.service');
    return ok(res, await svc.getFeature(req.user!.sub, param(req, 'id')));
  }),
);
