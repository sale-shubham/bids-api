import { Router } from 'express';
import Joi from 'joi';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireRole } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';
import { LEGAL_PAGE_SLUGS } from '@/modules/settings/legal-pages.constants';

// SUPER_ADMIN management of app settings. Handlers lazy-load the response helper
// + service via dynamic import() (Lambda cold-start convention).
const router = Router();
router.use(authenticate, requireRole('SUPER_ADMIN'));

// GET /admin/settings/pages → { pages } (same payload as the public route;
// separate so the admin editor never depends on public-route caching).
router.get(
  '/pages',
  asyncHandler(async (_req, res) => {
    const { ok } = await import('@/core/http/response');
    const { getLegalPages } = await import('@/modules/settings/legal-pages.service');
    return ok(res, { pages: await getLegalPages() });
  }),
);

// Content is trusted HTML authored by a SUPER_ADMIN in the rich-text editor and
// rendered with dangerouslySetInnerHTML on the public pages — the SUPER_ADMIN
// role IS the trust boundary here, so no tag whitelist is applied.
const legalPagesSchema = Joi.object({
  pages: Joi.array()
    .items(
      Joi.object({
        slug: Joi.string()
          .valid(...LEGAL_PAGE_SLUGS)
          .required(),
        content: Joi.string().allow('').max(200_000).required(),
      }),
    )
    .min(1)
    .required(),
});

// PUT /admin/settings/pages { pages: [{ slug, content }] } — bulk upsert.
router.put(
  '/pages',
  validate(legalPagesSchema),
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const { setLegalPages } = await import('@/modules/settings/legal-pages.service');
    return ok(res, { pages: await setLegalPages(req.body.pages) });
  }),
);

// GET /admin/settings/device-limit → { memberLimit, superAdminLimit } — the
// per-role device/session cap enforced by session.service.ts's
// upsertDeviceSession on every login. `memberLimit` applies uniformly to
// every BIDDER/AUCTIONEER account (no per-member override).
router.get(
  '/device-limit',
  asyncHandler(async (_req, res) => {
    const { ok } = await import('@/core/http/response');
    const { getDeviceLimitConfig } = await import('@/modules/settings/device-limit.service');
    return ok(res, await getDeviceLimitConfig());
  }),
);

const deviceLimitSchema = Joi.object({
  memberLimit: Joi.number().integer().min(1).max(20).required(),
  superAdminLimit: Joi.number().integer().min(1).max(20).required(),
});

// PUT /admin/settings/device-limit { memberLimit, superAdminLimit } — takes
// effect on each account's next new-device login (not retroactive to
// already-open sessions beyond the existing FIFO-eviction behavior).
router.put(
  '/device-limit',
  validate(deviceLimitSchema),
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const { setDeviceLimitConfig } = await import('@/modules/settings/device-limit.service');
    return ok(res, await setDeviceLimitConfig(req.body));
  }),
);

export default router;
