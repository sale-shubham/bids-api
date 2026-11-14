import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireActiveMember } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';
import { apiLimiter } from '@/core/middleware/rateLimit';
import { subscribeSchema, unsubscribeSchema } from './push.validation';
import * as ctrl from './push.controller';

// Web Push subscriptions — see readme/flows/push-notifications.md.
const router = Router();

// Public: the key is public by definition, and the service worker asks for it
// with no page around it (pushsubscriptionchange in web app public/sw.js).
router.get('/vapid-public-key', asyncHandler(ctrl.vapidPublicKey));

// The app re-posts its subscription on every open (an idempotent upsert), so
// these see a call per app load, not per message.
router.post('/subscribe', authenticate, requireActiveMember, apiLimiter, validate(subscribeSchema), asyncHandler(ctrl.subscribe));
router.post('/unsubscribe', authenticate, requireActiveMember, apiLimiter, validate(unsubscribeSchema), asyncHandler(ctrl.unsubscribe));

export default router;
