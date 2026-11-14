import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireRole } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';
import * as ctrl from './admin-retention.controller';
import { purgeRetentionSchema } from './admin-retention.validation';

const router = Router();
router.use(authenticate, requireRole('SUPER_ADMIN'));

router.post('/purge', validate(purgeRetentionSchema), asyncHandler(ctrl.purge));

export default router;
