import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { param } from '@/core/http/params';

const router = Router();
const CACHE = 'public, max-age=60';

// GET /categories -> { items: CategoryNode[] } (active tree, live counts incl. descendants)
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const { ok } = await import('@/core/http/response');
    const svc = await import('./categories.service');
    res.set('Cache-Control', CACHE);
    return ok(res, await svc.getCategoryTree());
  }),
);

// GET /categories/:slug/stats -> { liveCount, soldCount90d, medianSoldPaise }
router.get(
  '/:slug/stats',
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const svc = await import('./categories.service');
    res.set('Cache-Control', CACHE);
    return ok(res, await svc.categoryStats(param(req, 'slug')));
  }),
);

export default router;
