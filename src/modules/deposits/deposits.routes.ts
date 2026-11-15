import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireActiveMember, requireRole } from '@/core/middleware/auth';
import { param } from '@/core/http/params';

// Mounted inside the auctions router at /auctions/:id/deposit  (POST /auctions/:id/deposit/checkout)
export const auctionDepositRouter = Router({ mergeParams: true });

auctionDepositRouter.post(
  '/checkout',
  authenticate,
  requireRole('BIDDER'),
  requireActiveMember,
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const svc = await import('./deposits.service');
    return ok(res, await svc.checkout(req.user!.sub, param(req, 'id')));
  }),
);
