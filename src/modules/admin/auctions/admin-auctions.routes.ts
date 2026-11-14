import { Router } from 'express';
import Joi from 'joi';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireRole } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';

// Mounted at /admin/auctions — SUPER_ADMIN only. Cancelling uses DELETE /auctions/:id (admin always allowed).
const router = Router();
router.use(authenticate, requireRole('SUPER_ADMIN'));

const listQuerySchema = Joi.object({
  status: Joi.string().valid('live', 'upcoming', 'ended', 'cancelled'),
  q: Joi.string().trim().allow('').max(100),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(20),
});

// GET /admin/auctions?status=&q=&page=&pageSize= -> paginated AuctionCard & { sellerEmail }
router.get(
  '/',
  validate(listQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { paginated } = await import('@/core/http/response');
    const svc = await import('./admin-auctions.service');
    const { items, meta } = await svc.listAuctions(req.query as any);
    return paginated(res, items, meta, { serverTime: new Date().toISOString() });
  }),
);

export default router;
