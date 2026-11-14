import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireRole } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';
import { listMembersQuery, changeRoleBody } from './admin-members.validation';
import * as ctrl from './admin-members.controller';

const router = Router();

// SUPER_ADMIN only.
router.use(authenticate, requireRole('SUPER_ADMIN'));

router.get('/', validate(listMembersQuery, 'query'), asyncHandler(ctrl.list));
router.post('/:id/activate', asyncHandler(ctrl.activate));
router.post('/:id/deactivate', asyncHandler(ctrl.deactivate));
router.patch('/:id/role', validate(changeRoleBody), asyncHandler(ctrl.changeRole));

export default router;
