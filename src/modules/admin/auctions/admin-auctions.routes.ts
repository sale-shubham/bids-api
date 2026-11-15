import { Router } from 'express';
import Joi from 'joi';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireRole } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';
import { param } from '@/core/http/params';
import { HARD_MAX_PRICE_PAISE } from '@/core/money';

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

const depositBodySchema = Joi.object({
  depositPaise: Joi.number().integer().min(0).max(HARD_MAX_PRICE_PAISE).allow(null).required(),
});

// PATCH /admin/auctions/:id/deposit { depositPaise: integer >= 0 | null } -> { auction: { id, depositPaise } }
router.patch(
  '/:id/deposit',
  validate(depositBodySchema),
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const svc = await import('./admin-auctions.service');
    return ok(res, { auction: await svc.setDeposit(param(req, 'id'), req.body.depositPaise) });
  }),
);

export default router;
