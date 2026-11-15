import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireRole } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';
import { adminListReportsQuery, resolveReportBody } from '@/modules/reports/reports.validation';
import * as ctrl from './admin-reports.controller';

const router = Router();

// SUPER_ADMIN only.
router.use(authenticate, requireRole('SUPER_ADMIN'));

router.get('/', validate(adminListReportsQuery, 'query'), asyncHandler(ctrl.list));
router.patch('/:id', validate(resolveReportBody), asyncHandler(ctrl.resolve));

export default router;
