import type { Request, Response } from 'express';

export async function create(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./reports.service');
  return ok(res, await svc.createReport(req.user!.sub, req.body), 201);
}
