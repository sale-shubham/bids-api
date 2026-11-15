import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireActiveMember, requireRole } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';
import * as ctrl from './sales.controller';
import { disputeSchema, mineQuerySchema, shipSchema } from './sales.validation';

const router = Router();
const member = [authenticate, requireActiveMember];
const buyer = [authenticate, requireRole('BIDDER'), requireActiveMember];
const seller = [authenticate, requireRole('AUCTIONEER'), requireActiveMember];

router.get('/mine', ...member, validate(mineQuerySchema, 'query'), asyncHandler(ctrl.mine));
router.get('/:id', ...member, asyncHandler(ctrl.getOne));
router.post('/:id/checkout', ...buyer, asyncHandler(ctrl.checkout));
router.post('/:id/ship', ...seller, validate(shipSchema), asyncHandler(ctrl.ship));
router.post('/:id/confirm', ...buyer, asyncHandler(ctrl.confirm));
router.post('/:id/dispute', ...buyer, validate(disputeSchema), asyncHandler(ctrl.dispute));

export default router;
