import type { Request, Response } from 'express';
import { param } from '@/core/http/params';

// GET /admin/reports?status=&targetType=&page=&pageSize=
export async function list(req: Request, res: Response) {
  const { paginated } = await import('@/core/http/response');
  const svc = await import('./admin-reports.service');
  const { items, meta } = await svc.listReports(req.query as never);
  return paginated(res, items, meta);
}

// PATCH /admin/reports/:id { status, note?, applyToAllOpenForTarget? } -> { report, resolvedCount }
export async function resolve(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./admin-reports.service');
  return ok(res, await svc.resolveReport(param(req, 'id'), req.user!.sub, req.body));
}
