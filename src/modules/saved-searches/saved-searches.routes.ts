import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireActiveMember, requireRole } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';
import * as ctrl from './saved-searches.controller';
import { createSavedSearchSchema } from './saved-searches.validation';

// Mounted at /saved-searches — active MEMBER members.
const router = Router();
router.use(authenticate, requireRole('MEMBER'), requireActiveMember);

router.get('/', asyncHandler(ctrl.list));
router.post('/', validate(createSavedSearchSchema), asyncHandler(ctrl.create));
router.delete('/:id', asyncHandler(ctrl.remove));

export default router;
