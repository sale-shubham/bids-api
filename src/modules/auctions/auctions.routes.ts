import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, optionalAuthenticate, requireActiveMember, requireRole } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';
import { auctionWriteLimiter } from '@/core/middleware/rateLimit';
import { auctionBidsRouter } from '@/modules/bids/bids.routes';
import * as ctrl from './auctions.controller';
import {
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
router.get('/mine', ...seller, validate(mineQuerySchema, 'query'), asyncHandler(ctrl.mine));
router.post('/', ...seller, auctionWriteLimiter, validate(createAuctionSchema), asyncHandler(ctrl.create));

router.use('/:id/bids', auctionBidsRouter);
router.get('/:id', optionalAuthenticate, asyncHandler(ctrl.detail));
router.patch('/:id', ...seller, auctionWriteLimiter, validate(updateAuctionSchema), asyncHandler(ctrl.update));
router.delete('/:id', ...seller, asyncHandler(ctrl.remove));
router.post('/:id/republish', ...seller, auctionWriteLimiter, validate(republishSchema), asyncHandler(ctrl.republish));

export default router;
