import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { validate } from '@/core/middleware/validate';
import { LEGAL_PAGE_SLUGS, type LegalPageSlug } from './legal-pages.constants';
import { legalSlugParamSchema } from './settings.validation';
import { param } from '@/core/http/params';

// Public, read-only settings the frontend needs pre-login.
// Admin-side read/write lives at /admin/settings (SUPER_ADMIN only).
const router = Router();

// GET /settings/public -> { commissionRateBps, minIncrementPaise, antiSnipingMinutes, categories }
router.get(
  '/public',
  asyncHandler(async (_req, res) => {
    const { ok } = await import('@/core/http/response');
    const { getPlatformSettings } = await import('./settings.service');
    return ok(res, await getPlatformSettings());
  }),
);

// GET /settings/legal -> { pages: [{ slug, title, content, updatedAt }] }
router.get(
  '/legal',
  asyncHandler(async (_req, res) => {
    const { ok } = await import('@/core/http/response');
    const { getLegalPages } = await import('./legal-pages.service');
    return ok(res, { pages: await getLegalPages() });
  }),
);

// GET /settings/legal/:slug -> { slug, title, content (HTML), updatedAt }
router.get(
  '/legal/:slug',
  validate(legalSlugParamSchema(LEGAL_PAGE_SLUGS), 'params'),
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const { getLegalPage } = await import('./legal-pages.service');
    return ok(res, await getLegalPage(param(req, 'slug') as LegalPageSlug));
  }),
);

export default router;
