import { Router } from 'express';
import Joi from 'joi';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireRole } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';
import { param } from '@/core/http/params';
import { invoiceSettingsSchema } from '@/modules/invoices/invoices.validation';
import { LEGAL_PAGE_SLUGS, type LegalPageSlug } from '@/modules/settings/legal-pages.constants';
import {
  legalPageBodySchema,
  legalSlugParamSchema,
  platformSettingsSchema,
} from '@/modules/settings/settings.validation';

// SUPER_ADMIN management of app settings. Handlers lazy-load the response helper
// + service via dynamic import() (Lambda cold-start convention).
const router = Router();
router.use(authenticate, requireRole('SUPER_ADMIN'));

// GET /admin/settings -> { commissionRateBps, minIncrementPaise, antiSnipingMinutes, categories }
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const { ok } = await import('@/core/http/response');
    const { getPlatformSettings } = await import('@/modules/settings/settings.service');
    return ok(res, await getPlatformSettings());
  }),
);

// PUT /admin/settings — whole object, same shape back.
router.put(
  '/',
  validate(platformSettingsSchema),
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const { setPlatformSettings } = await import('@/modules/settings/settings.service');
    return ok(res, await setPlatformSettings(req.body));
  }),
);

// GET /admin/settings/legal -> { pages } (admin editor list; never cached publicly).
router.get(
  '/legal',
  asyncHandler(async (_req, res) => {
    const { ok } = await import('@/core/http/response');
    const { getLegalPages } = await import('@/modules/settings/legal-pages.service');
    return ok(res, { pages: await getLegalPages() });
  }),
);

// PUT /admin/settings/legal/:slug { title, content } -> page. Content is sanitised server-side.
router.put(
  '/legal/:slug',
  validate(legalSlugParamSchema(LEGAL_PAGE_SLUGS), 'params'),
  validate(legalPageBodySchema),
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const { setLegalPage } = await import('@/modules/settings/legal-pages.service');
    return ok(res, await setLegalPage(param(req, 'slug') as LegalPageSlug, req.body));
  }),
);

// GET /admin/settings/invoice -> platform billing identity (admin-only, never public).
router.get(
  '/invoice',
  asyncHandler(async (_req, res) => {
    const { ok } = await import('@/core/http/response');
    const { getInvoiceSettings } = await import('@/modules/invoices/invoice.settings');
    return ok(res, await getInvoiceSettings());
  }),
);

// PUT /admin/settings/invoice (whole object; gstin optional, must match stateCode)
router.put(
  '/invoice',
  validate(invoiceSettingsSchema),
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const { setInvoiceSettings } = await import('@/modules/invoices/invoice.settings');
    return ok(res, await setInvoiceSettings({ ...req.body, gstin: req.body.gstin || null }));
  }),
);

// GET /admin/settings/device-limit -> { memberLimit, superAdminLimit }
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

// PUT /admin/settings/device-limit { memberLimit, superAdminLimit }
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
