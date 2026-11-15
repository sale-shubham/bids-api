import type { Request, Response } from 'express';
import { NotFound } from '@/core/errors/AppError';
import { param } from '@/core/http/params';

// GET /members/me — profile plus this account's own device cap.
export async function me(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./members.service');
  const member = await svc.getMemberDto(req.user!.sub);
  if (!member) throw NotFound('Member not found');
  return ok(res, { member });
}

// PATCH /members/me — self-service profile update.
export async function updateMe(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./members.service');
  await svc.updateProfile(req.user!.sub, req.body);
  const member = await svc.getMemberDto(req.user!.sub);
  return ok(res, { member });
}

// GET /members/:id/public — safe fields only.
export async function publicProfile(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('./members.service');
  const member = await svc.getPublicProfile(param(req, 'id'), req.user?.sub);
  if (!member) throw NotFound('Member not found');
  return ok(res, member);
}

// POST /members/me/phone/otp — { sentTo }
export async function sendPhoneOtp(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const phone = await import('./phone.service');
  return ok(res, await phone.sendPhoneOtp(req.body.phone));
}

// POST /members/me/phone/verify — { member }
export async function verifyPhone(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const phone = await import('./phone.service');
  const svc = await import('./members.service');
  await phone.verifyPhone(req.user!.sub, req.body.phone, req.body.code);
  return ok(res, { member: await svc.getMemberDto(req.user!.sub) });
}

// GET /members/me/following — sellers the caller follows.
export async function following(req: Request, res: Response) {
  const { paginated } = await import('@/core/http/response');
  const svc = await import('@/modules/follows/follows.service');
  const { items, meta } = await svc.listFollowing(req.user!.sub, req.query as unknown as { page: number; pageSize: number });
  return paginated(res, items, meta);
}

// GET /members/me/notification-preferences
export async function getNotificationPreferences(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('@/modules/notification-preferences/notification-preferences.service');
  return ok(res, await svc.getPreferences(req.user!.sub, req.user!.role));
}

// PUT /members/me/notification-preferences
export async function putNotificationPreferences(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('@/modules/notification-preferences/notification-preferences.service');
  return ok(res, await svc.updatePreferences(req.user!.sub, req.user!.role, req.body.items));
}

// POST /members/me/whatsapp — { whatsappOptIn }
export async function setWhatsapp(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const svc = await import('@/modules/notification-preferences/notification-preferences.service');
  return ok(res, await svc.setWhatsappOptIn(req.user!.sub, req.body.optIn));
}
