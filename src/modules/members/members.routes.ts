import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireActiveMember } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';
import * as ctrl from './members.controller';
import * as reviewsCtrl from '@/modules/reviews/reviews.controller';
import { reviewListQuerySchema } from '@/modules/reviews/reviews.validation';
import { authLimiter, otpIpLimiter, otpLimiter } from '@/core/middleware/rateLimit';
import { phoneOtpSchema, phoneVerifySchema, updateMeSchema } from './members.validation';

const router = Router();

router.get('/me', authenticate, asyncHandler(ctrl.me));
router.patch('/me', authenticate, requireActiveMember, validate(updateMeSchema), asyncHandler(ctrl.updateMe));
router.post(
  '/me/phone/otp',
  authenticate,
  requireActiveMember,
  otpIpLimiter,
  otpLimiter,
  validate(phoneOtpSchema),
  asyncHandler(ctrl.sendPhoneOtp),
);
router.post(
  '/me/phone/verify',
  authenticate,
  requireActiveMember,
  authLimiter,
  validate(phoneVerifySchema),
  asyncHandler(ctrl.verifyPhone),
);
// Declared after /me so "me" is never read as an id.
router.get('/:id/public', asyncHandler(ctrl.publicProfile));
router.get('/:id/reviews', validate(reviewListQuerySchema, 'query'), asyncHandler(reviewsCtrl.listForSeller));

export default router;
