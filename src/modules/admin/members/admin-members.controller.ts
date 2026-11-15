import type { Request, Response } from 'express';
import { param } from '@/core/http/params';

export async function list(req: Request, res: Response) {
  const { paginated } = await import('@/core/http/response');
  const { pageMeta } = await import('@/core/http/pagination');
  const svc = await import('./admin-members.service');
  const { status, role, q, page, pageSize, sortBy, sortOrder } = req.query as any;
  const { items, total, stats } = await svc.listMembers({ status, role, search: q, page, pageSize, sortBy, sortOrder });
  return paginated(res, items, pageMeta(total, { page, pageSize }), { stats });
}

// PATCH /admin/members/:id { isActive?, role? } -> { member }
export async function update(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./admin-members.service');
  return ok(res, { member: await svc.updateMember(param(req, 'id'), req.user!.sub, req.body) });
}

// GET /admin/members/:id/strikes -> { items }
export async function strikes(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('@/modules/strikes/strikes.service');
  return ok(res, await svc.listMemberStrikes(param(req, 'id')));
}
