import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireActiveMember, requireRole } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';
import * as ctrl from './reviews.controller';
import { createReviewSchema, replySchema } from './reviews.validation';

// Mounted at /reviews  (POST /reviews/:id/reply)
export const reviewsRouter = Router();
reviewsRouter.post(
  '/:id/reply',
  authenticate,
  requireRole('MEMBER', 'SUPER_ADMIN'),
  requireActiveMember,
  validate(replySchema),
  asyncHandler(ctrl.reply),
);

// Mounted inside the auctions router  (POST /auctions/:id/review)
export const auctionReviewRouter = Router({ mergeParams: true });
auctionReviewRouter.post(
  '/',
  authenticate,
  requireRole('MEMBER'),
  requireActiveMember,
  validate(createReviewSchema),
  asyncHandler(ctrl.create),
);
