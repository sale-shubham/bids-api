import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireActiveMember, requireRole } from '@/core/middleware/auth';
import { sensitiveLimiter } from '@/core/middleware/rateLimit';
import { validate } from '@/core/middleware/validate';
import * as ctrl from './payouts.controller';
import { createAccountSchema } from './payouts.validation';

const router = Router();
const seller = [authenticate, requireRole('AUCTIONEER'), requireActiveMember];

router.get('/account', ...seller, asyncHandler(ctrl.getAccount));
router.post('/account', ...seller, sensitiveLimiter, validate(createAccountSchema), asyncHandler(ctrl.createAccount));

export default router;
