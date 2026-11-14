import { Router } from 'express';
import Joi from 'joi';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { validate } from '@/core/middleware/validate';
import { LEGAL_PAGE_SLUGS, type LegalPageSlug } from './legal-pages.constants';
import { param } from '@/core/http/params';

// Public, read-only settings the frontend needs pre-login (marketing pages).
// Admin-side read/write lives at /admin/settings (SUPER_ADMIN only).
const router = Router();

// GET /settings/pages → { pages: [{ slug, name, content, updatedAt }] }
// Legal/content pages (Privacy Policy, Terms & Conditions, Refund Policy) — public because
// the signup flow links straight to them.
router.get(
  '/pages',
  asyncHandler(async (_req, res) => {
    const { ok } = await import('@/core/http/response');
    const { getLegalPages } = await import('./legal-pages.service');
    return ok(res, { pages: await getLegalPages() });
  }),
);

const pageSlugParamSchema = Joi.object({
  slug: Joi.string()
    .valid(...LEGAL_PAGE_SLUGS)
    .required(),
});

// GET /settings/pages/:slug → { page }
router.get(
  '/pages/:slug',
  validate(pageSlugParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const { getLegalPage } = await import('./legal-pages.service');
    return ok(res, { page: await getLegalPage(param(req, 'slug') as LegalPageSlug) });
  }),
);

export default router;
