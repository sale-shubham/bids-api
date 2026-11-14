import type { Request, Response } from 'express';

export async function ticket(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./ws.service');
  return ok(res, await svc.issueTicket(req.user!.sub));
}
