import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, optionalAuthenticate, requireActiveMember, requireRole } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';
import { bidAuctionLimiter, bidMemberLimiter } from '@/core/middleware/rateLimit';
import * as ctrl from './bids.controller';
import { listBidsQuerySchema, myBidsQuerySchema, placeBidSchema } from './bids.validation';

// Mounted at /bids  (GET /bids/mine)
export const bidsRouter = Router();
bidsRouter.get(
  '/mine',
  authenticate,
  requireRole('MEMBER'),
  requireActiveMember,
  validate(myBidsQuerySchema, 'query'),
  asyncHandler(ctrl.mine),
);

// Mounted inside the auctions router  (POST|GET /auctions/:id/bids, POST /auctions/:id/buy-now)
export const auctionBidsRouter = Router({ mergeParams: true });
auctionBidsRouter.post(
  '/',
  authenticate,
  requireRole('MEMBER'),
  requireActiveMember,
  bidAuctionLimiter,
  bidMemberLimiter,
  validate(placeBidSchema),
  asyncHandler(ctrl.place),
);
auctionBidsRouter.get('/', optionalAuthenticate, validate(listBidsQuerySchema, 'query'), asyncHandler(ctrl.list));

// Mounted at /auctions/:id/buy-now (no body)
export const auctionBuyNowRouter = Router({ mergeParams: true });
auctionBuyNowRouter.post(
  '/',
  authenticate,
  requireRole('MEMBER'),
  requireActiveMember,
  bidAuctionLimiter,
  bidMemberLimiter,
  asyncHandler(ctrl.buyNow),
);
