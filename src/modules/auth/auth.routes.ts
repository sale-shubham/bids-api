import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireActiveMember } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';
import { authLimiter, loginEmailLimiter, otpIpLimiter, otpLimiter } from '@/core/middleware/rateLimit';
import * as ctrl from './auth.controller';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  resendSchema,
  resetPasswordSchema,
  signupSchema,
  verifySignupSchema,
} from './auth.validation';

const router = Router();

// Email-sending routes: per-IP cap across all emails, then per IP+email.
const sendsOtp = [otpIpLimiter, otpLimiter];

router.post('/signup', ...sendsOtp, validate(signupSchema), asyncHandler(ctrl.signup));
router.post('/signup/verify', authLimiter, validate(verifySignupSchema), asyncHandler(ctrl.verifySignup));
router.post('/signup/resend', ...sendsOtp, validate(resendSchema), asyncHandler(ctrl.resendSignup));
router.post('/login', authLimiter, loginEmailLimiter, validate(loginSchema), asyncHandler(ctrl.login));
router.post('/password/forgot', ...sendsOtp, validate(forgotPasswordSchema), asyncHandler(ctrl.forgotPassword));
router.post('/password/reset', authLimiter, validate(resetPasswordSchema), asyncHandler(ctrl.resetPassword));
router.post(
  '/password/change',
  authenticate,
  requireActiveMember,
  authLimiter,
  validate(changePasswordSchema),
  asyncHandler(ctrl.changePassword),
);
router.post('/refresh', asyncHandler(ctrl.refresh));
router.post('/logout', asyncHandler(ctrl.logout));
router.post('/logout-all', authenticate, asyncHandler(ctrl.logoutAll));
router.get('/sessions', authenticate, asyncHandler(ctrl.listSessions));
router.delete('/sessions/:id', authenticate, asyncHandler(ctrl.revokeSession));

export default router;
