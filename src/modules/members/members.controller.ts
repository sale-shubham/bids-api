import type { Request, Response } from 'express';
import { NotFound } from '@/core/errors/AppError';

// GET /members/me — profile plus this account's own device cap.
export async function me(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./members.service');
  const member = await svc.getProfile(req.user!.sub);
  if (!member) throw NotFound('Member not found');
  const { getMaxDevicesForRole } = await import('@/modules/settings/device-limit.service');
  const deviceLimit = await getMaxDevicesForRole(member.role);
  return ok(res, { ...member, deviceLimit });
}

// PATCH /members/me — self-service profile update.
export async function updateMe(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./members.service');
  const member = await svc.updateProfile(req.user!.sub, req.body);
  return ok(res, { member, message: 'Profile updated.' });
}

// TODO(Phase 1): public profile (GET /members/:id) and avatar upload.
