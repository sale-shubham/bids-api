import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate } from '@/core/middleware/auth';
import * as ctrl from './auth.controller';

const router = Router();

// TODO(Phase 1): POST /signup, /verify-email, /login, /forgot-password,
// /reset-password (email + password; email OTP only for verify + reset).
router.post('/refresh', asyncHandler(ctrl.refresh));
router.post('/logout', asyncHandler(ctrl.logout));
router.post('/logout-all', authenticate, asyncHandler(ctrl.logoutAll));
router.get('/sessions', authenticate, asyncHandler(ctrl.listSessions));
router.delete('/sessions/:id', authenticate, asyncHandler(ctrl.revokeSession));

export default router;
