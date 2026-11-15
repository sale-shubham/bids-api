import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireRole } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';
import { hideReviewBody, listReviewsQuery } from './admin-reviews.validation';
import * as ctrl from './admin-reviews.controller';

const router = Router();

// SUPER_ADMIN only.
router.use(authenticate, requireRole('SUPER_ADMIN'));

router.get('/', validate(listReviewsQuery, 'query'), asyncHandler(ctrl.list));
router.patch('/:id', validate(hideReviewBody), asyncHandler(ctrl.setHidden));

export default router;
