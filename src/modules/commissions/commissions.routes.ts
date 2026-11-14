import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireActiveMember, requireRole } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';
import * as ctrl from './commissions.controller';
import { mineQuerySchema } from './commissions.validation';

const router = Router();
const seller = [authenticate, requireRole('AUCTIONEER', 'SUPER_ADMIN'), requireActiveMember];

router.get('/mine', ...seller, validate(mineQuerySchema, 'query'), asyncHandler(ctrl.mine));
router.get('/summary', ...seller, asyncHandler(ctrl.summary));
router.post('/:id/checkout', ...seller, asyncHandler(ctrl.checkout));

export default router;
