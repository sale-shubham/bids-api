import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireActiveMember, requireRole } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';
import * as ctrl from './commissions.controller';
import { checkoutBodySchema, mineQuerySchema } from './commissions.validation';

const router = Router();
const seller = [authenticate, requireRole('MEMBER', 'SUPER_ADMIN'), requireActiveMember];

router.get('/mine', ...seller, validate(mineQuerySchema, 'query'), asyncHandler(ctrl.mine));
router.get('/summary', ...seller, asyncHandler(ctrl.summary));
router.get('/:id', ...seller, asyncHandler(ctrl.getOne));
router.post('/:id/checkout', ...seller, validate(checkoutBodySchema), asyncHandler(ctrl.checkout));

export default router;
