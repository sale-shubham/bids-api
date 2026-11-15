import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireRole } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';
import { listMembersQuery, updateMemberBody } from './admin-members.validation';
import * as ctrl from './admin-members.controller';

const router = Router();

// SUPER_ADMIN only.
router.use(authenticate, requireRole('SUPER_ADMIN'));

router.get('/', validate(listMembersQuery, 'query'), asyncHandler(ctrl.list));
router.patch('/:id', validate(updateMemberBody), asyncHandler(ctrl.update));
router.get('/:id/strikes', asyncHandler(ctrl.strikes));

export default router;
