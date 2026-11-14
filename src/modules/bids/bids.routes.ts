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
  requireRole('BIDDER'),
  requireActiveMember,
  validate(myBidsQuerySchema, 'query'),
  asyncHandler(ctrl.mine),
);

// Mounted inside the auctions router  (POST|GET /auctions/:id/bids)
export const auctionBidsRouter = Router({ mergeParams: true });
auctionBidsRouter.post(
  '/',
  authenticate,
  requireRole('BIDDER'),
  requireActiveMember,
  bidAuctionLimiter,
  bidMemberLimiter,
  validate(placeBidSchema),
  asyncHandler(ctrl.place),
);
auctionBidsRouter.get('/', optionalAuthenticate, validate(listBidsQuerySchema, 'query'), asyncHandler(ctrl.list));
