import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireActiveMember } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';
import { sensitiveLimiter } from '@/core/middleware/rateLimit';
import * as ctrl from './uploads.controller';
import { presignSchema } from './uploads.validation';

const router = Router();

router.use(authenticate, requireActiveMember);

router.post('/presign', sensitiveLimiter, validate(presignSchema), asyncHandler(ctrl.presign));

export default router;
