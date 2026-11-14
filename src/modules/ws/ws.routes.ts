import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireActiveMember } from '@/core/middleware/auth';
import { apiLimiter } from '@/core/middleware/rateLimit';
import * as ctrl from './ws.controller';

const router = Router();
router.use(authenticate, requireActiveMember);

// Rate-limited — a reconnect loop gone wrong (e.g. a bad ticket causing an
// immediate reconnect attempt) must not be able to hammer this for free;
// each ticket is only good for one connection attempt anyway, so a
// legitimate client calls this once per socket open, not per message.
router.post('/ticket', apiLimiter, asyncHandler(ctrl.ticket));

export default router;
