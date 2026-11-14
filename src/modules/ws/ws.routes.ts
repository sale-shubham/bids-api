import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireActiveMember } from '@/core/middleware/auth';
import { apiLimiter, wsGuestLimiter } from '@/core/middleware/rateLimit';
import * as ctrl from './ws.controller';

const router = Router();

// Public: guests may watch auction rooms. Per-IP limited; ticket has no member.
router.post('/guest-ticket', wsGuestLimiter, asyncHandler(ctrl.guestTicket));

// Authenticated. Rate-limited so a bad reconnect loop can't hammer it; each
// ticket is single-use, so a legitimate client calls this once per socket open.
router.post('/ticket', authenticate, requireActiveMember, apiLimiter, asyncHandler(ctrl.ticket));

export default router;
