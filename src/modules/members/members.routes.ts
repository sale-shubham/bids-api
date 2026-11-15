import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, optionalAuthenticate, requireActiveMember } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';
import * as ctrl from './members.controller';
import * as reviewsCtrl from '@/modules/reviews/reviews.controller';
import { reviewListQuerySchema } from '@/modules/reviews/reviews.validation';
import { followingQuerySchema } from '@/modules/follows/follows.validation';
import { updatePreferencesSchema } from '@/modules/notification-preferences/notification-preferences.validation';
import { creditsQuerySchema, updateMeSchema } from './members.validation';

const router = Router();

router.get('/me', authenticate, asyncHandler(ctrl.me));
router.patch('/me', authenticate, requireActiveMember, validate(updateMeSchema), asyncHandler(ctrl.updateMe));
router.get('/me/following', authenticate, requireActiveMember, validate(followingQuerySchema, 'query'), asyncHandler(ctrl.following));
router.get('/me/notification-preferences', authenticate, requireActiveMember, asyncHandler(ctrl.getNotificationPreferences));
router.put(
  '/me/notification-preferences',
  authenticate,
  requireActiveMember,
  validate(updatePreferencesSchema),
  asyncHandler(ctrl.putNotificationPreferences),
);
router.get(
  '/me/referral',
  authenticate,
  requireActiveMember,
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const svc = await import('@/modules/referrals/referrals.service');
    return ok(res, await svc.getReferralSummary(req.user!.sub));
  }),
);
router.get(
  '/me/credits',
  authenticate,
  requireActiveMember,
  validate(creditsQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { paginated } = await import('@/core/http/response');
    const svc = await import('@/modules/credits/credits.service');
    const { items, meta, balancePaise } = await svc.listLedger(req.user!.sub, req.query as unknown as { page: number; pageSize: number });
    return paginated(res, items, meta, { balancePaise });
  }),
);
// Declared after /me so "me" is never read as an id.
router.get('/:id/public', optionalAuthenticate, asyncHandler(ctrl.publicProfile));
router.get('/:id/reviews', validate(reviewListQuerySchema, 'query'), asyncHandler(reviewsCtrl.listForSeller));

export default router;
