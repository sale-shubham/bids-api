import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireActiveMember } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';
import * as ctrl from './members.controller';
import { updateMeSchema } from './members.validation';

const router = Router();

router.get('/me', authenticate, asyncHandler(ctrl.me));
router.patch('/me', authenticate, requireActiveMember, validate(updateMeSchema), asyncHandler(ctrl.updateMe));
// Declared after /me so "me" is never read as an id.
router.get('/:id/public', asyncHandler(ctrl.publicProfile));

export default router;
