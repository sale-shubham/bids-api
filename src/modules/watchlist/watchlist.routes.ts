import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireActiveMember } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';
import { param } from '@/core/http/params';
import { listQuerySchema, type WatchlistQuery } from './watchlist.validation';

// Mounted at /watchlist — any logged-in, active member.
const router = Router();
router.use(authenticate, requireActiveMember);

router.get(
  '/',
  validate(listQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { paginated } = await import('@/core/http/response');
    const svc = await import('./watchlist.service');
    const { items, meta } = await svc.listWatchlist(req.user!.sub, req.query as unknown as WatchlistQuery);
    return paginated(res, items, meta, { serverTime: new Date().toISOString() });
  }),
);

// Before /:auctionId so "ids" is never read as an auction id.
router.get(
  '/ids',
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const svc = await import('./watchlist.service');
    return ok(res, await svc.watchlistIds(req.user!.sub));
  }),
);

router.post(
  '/:auctionId',
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const svc = await import('./watchlist.service');
    return ok(res, await svc.addToWatchlist(req.user!.sub, param(req, 'auctionId')));
  }),
);

router.delete(
  '/:auctionId',
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const svc = await import('./watchlist.service');
    return ok(res, await svc.removeFromWatchlist(req.user!.sub, param(req, 'auctionId')));
  }),
);

export default router;
