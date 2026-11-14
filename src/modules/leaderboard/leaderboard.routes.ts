import { Router } from 'express';
import Joi from 'joi';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { validate } from '@/core/middleware/validate';

// Mounted at /leaderboard — public.
const router = Router();

export const leaderboardQuerySchema = Joi.object({
  by: Joi.string().valid('spent', 'won').default('spent'),
  limit: Joi.number().integer().min(1).max(50).default(20),
});

router.get(
  '/',
  validate(leaderboardQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { ok } = await import('@/core/http/response');
    const svc = await import('./leaderboard.service');
    const { by, limit } = req.query as unknown as { by: 'spent' | 'won'; limit: number };
    return ok(res, await svc.getLeaderboard(by, limit));
  }),
);

export default router;
