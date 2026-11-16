import type { Request, Response } from 'express';
import { param } from '@/core/http/params';

export async function list(req: Request, res: Response) {
  const { paginated } = await import('@/core/http/response');
  const { pageMeta } = await import('@/core/http/pagination');
  const svc = await import('./admin-members.service');
  const { status, seller, q, page, pageSize, sortBy, sortOrder } = req.query as any;
  const { items, total, stats } = await svc.listMembers({ status, seller, search: q, page, pageSize, sortBy, sortOrder });
  return paginated(res, items, pageMeta(total, { page, pageSize }), { stats });
}

// PATCH /admin/members/:id { isActive?, verified? } -> { member }
export async function update(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./admin-members.service');
  return ok(res, { member: await svc.updateMember(param(req, 'id'), req.user!.sub, req.body) });
}

// POST /admin/members/:id/credits { amountPaise, note } -> { creditBalancePaise }
export async function adjustCredits(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  await (await import('./admin-members.service')).assertManageable(param(req, 'id'));
  const svc = await import('@/modules/credits/credits.service');
  return ok(res, await svc.adminAdjust(param(req, 'id'), req.user!.sub, req.body), 201);
}

// GET /admin/members/:id/strikes -> { items }
export async function strikes(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  await (await import('./admin-members.service')).assertManageable(param(req, 'id'));
  const svc = await import('@/modules/strikes/strikes.service');
  return ok(res, await svc.listMemberStrikes(param(req, 'id')));
}
