import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';
import * as ctrl from './members.controller';
import { updateMeSchema } from './members.validation';

const router = Router();

router.get('/me', authenticate, asyncHandler(ctrl.me));
router.patch('/me', authenticate, validate(updateMeSchema), asyncHandler(ctrl.updateMe));

export default router;
