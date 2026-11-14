import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, requireRole } from '@/core/middleware/auth';

// Inline handlers lazy-load response helpers / services via dynamic import() (Lambda cold start).
const router = Router();
router.use(authenticate, requireRole('SUPER_ADMIN'));

// GET /admin/dashboard -> { totals, revenueByMonth, signupsByMonth, recentAuctions }
router.get(
  '/dashboard',
  asyncHandler(async (_req, res) => {
    const { ok } = await import('@/core/http/response');
    const svc = await import('./admin-dashboard.service');
    return ok(res, await svc.getDashboard());
  }),
);

export default router;
