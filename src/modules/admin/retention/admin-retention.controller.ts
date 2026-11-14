import type { Request, Response } from 'express';

// POST /admin/retention/purge — manual trigger, same job the daily schedule
// (index.ts retentionPurgeHandler) runs. Optional body overrides the fixed
// constant defaults (admin-retention.service.ts) for a one-off run.
export async function purge(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./admin-retention.service');
  const result = await svc.runRetentionPurge(req.body);
  return ok(res, result);
}
