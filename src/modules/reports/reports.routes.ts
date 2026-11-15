import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireActiveMember } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';
import { reportLimiter } from '@/core/middleware/rateLimit';
import * as ctrl from './reports.controller';
import { createReportSchema } from './reports.validation';

const router = Router();

// POST /reports { targetType, targetId, reason, details? } -> 201 { report: { id, status } }
router.post('/', authenticate, requireActiveMember, reportLimiter, validate(createReportSchema), asyncHandler(ctrl.create));

export default router;
