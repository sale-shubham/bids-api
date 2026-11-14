import type { Request, Response } from 'express';
import { param } from '@/core/http/params';

export async function list(req: Request, res: Response) {
  const { paginated } = await import('@/core/http/response');
  const { pageMeta } = await import('@/core/http/pagination');
  const svc = await import('./admin-members.service');
  const { status, role, search, page, pageSize, sortBy, sortOrder } = req.query as any;
  const { items, total, stats } = await svc.listMembers({ status, role, search, page, pageSize, sortBy, sortOrder });
  return paginated(res, items, pageMeta(total, { page, pageSize }), { stats });
}

export async function activate(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./admin-members.service');
  return ok(res, await svc.setMemberActive(param(req, 'id'), true));
}

export async function deactivate(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./admin-members.service');
  return ok(res, await svc.setMemberActive(param(req, 'id'), false));
}

export async function changeRole(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./admin-members.service');
  return ok(res, await svc.setMemberRole(param(req, 'id'), req.body.role));
}
