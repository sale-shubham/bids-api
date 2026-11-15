import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, optionalAuthenticate, requireActiveMember, requireRole } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';
import { auctionWriteLimiter, bulkLimiter, viewLimiter } from '@/core/middleware/rateLimit';
import { auctionBidsRouter, auctionBuyNowRouter } from '@/modules/bids/bids.routes';
import { auctionReviewRouter } from '@/modules/reviews/reviews.routes';
import { auctionQuestionsRouter } from '@/modules/questions/questions.routes';
import { auctionDepositRouter } from '@/modules/deposits/deposits.routes';
import { auctionFeatureRouter } from '@/modules/featured/featured.routes';
import { promotedQuerySchema } from '@/modules/featured/featured.validation';
import * as ctrl from './auctions.controller';
import { viewBodySchema } from '@/modules/analytics/analytics.validation';
import {
  bulkCreateSchema,
  createAuctionSchema,
  listQuerySchema,
  mineQuerySchema,
  republishSchema,
  updateAuctionSchema,
} from './auctions.validation';

const router = Router();
const seller = [authenticate, requireRole('AUCTIONEER', 'SUPER_ADMIN'), requireActiveMember];

// Fixed paths first so "home" / "categories" / "mine" are never read as an :id.
router.get('/', validate(listQuerySchema, 'query'), asyncHandler(ctrl.list));
router.get('/home', asyncHandler(ctrl.home));
router.get('/categories', asyncHandler(ctrl.categories));
router.get('/promoted', validate(promotedQuerySchema, 'query'), asyncHandler(ctrl.promoted));
router.get('/sitemap', asyncHandler(ctrl.sitemap));
router.get('/mine', ...seller, validate(mineQuerySchema, 'query'), asyncHandler(ctrl.mine));
router.post('/', ...seller, auctionWriteLimiter, validate(createAuctionSchema), asyncHandler(ctrl.create));

router.post('/bulk', ...seller, bulkLimiter, validate(bulkCreateSchema), asyncHandler(ctrl.bulkCreate));

router.use('/:id/bids', auctionBidsRouter);
router.use('/:id/buy-now', auctionBuyNowRouter);
router.use('/:id/review', auctionReviewRouter);
router.use('/:id/questions', auctionQuestionsRouter);
router.use('/:id/deposit', auctionDepositRouter);
router.use('/:id/feature', auctionFeatureRouter);
router.post('/:id/view', optionalAuthenticate, viewLimiter, validate(viewBodySchema), asyncHandler(ctrl.recordView));
router.get('/:id/similar-sold', asyncHandler(ctrl.similarSold));
router.get('/:id', optionalAuthenticate, asyncHandler(ctrl.detail));
router.patch('/:id', ...seller, auctionWriteLimiter, validate(updateAuctionSchema), asyncHandler(ctrl.update));
router.delete('/:id', ...seller, asyncHandler(ctrl.remove));
router.post('/:id/republish', ...seller, auctionWriteLimiter, validate(republishSchema), asyncHandler(ctrl.republish));

export default router;
