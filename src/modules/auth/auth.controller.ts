import type { Request, Response } from 'express';
import { setAuthCookies, setAccessCookie, clearAuthCookies } from '@/core/http/cookies';
import { REFRESH_COOKIE } from '@/core/middleware/auth';
import { Unauthorized } from '@/core/errors/AppError';
import { verifyRefreshToken } from './token.service';
import { param } from '@/core/http/params';
import type { Role } from '@prisma/client';

// Handlers lazy-load their service + response helpers via dynamic import() so
// these modules are only initialized on first use — keeps Lambda cold start
// tight. Routes stay statically registered (see routes.ts).

// Starts a session for a verified member and sets the auth cookies.
async function startSession(
  req: Request,
  res: Response,
  member: { id: string; role: Role },
) {
  const authService = await import('./auth.service');
  const { getOrCreateDeviceId, buildDeviceMeta } = await import('./device.service');
  const deviceId = getOrCreateDeviceId(req, res);
  const meta = buildDeviceMeta(req, req.body?.deviceInfo);
  const r = await authService.issueSession(member, deviceId, meta);
  setAuthCookies(res, r.accessToken, r.refreshToken, r.refreshExpiresAt);
}

async function memberDto(id: string) {
  const { getMemberDto } = await import('@/modules/members/members.service');
  return getMemberDto(id);
}

export async function signup(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const authService = await import('./auth.service');
  const { resendAfterSec } = await authService.signup(req.body);
  return ok(res, { email: req.body.email, resendAfterSec }, 201);
}

export async function verifySignup(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const authService = await import('./auth.service');
  const verified = await authService.verifySignup(req.body.email, req.body.code);
  await startSession(req, res, verified);
  return ok(res, { member: await memberDto(verified.id) });
}

export async function resendSignup(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const authService = await import('./auth.service');
  return ok(res, await authService.resendSignup(req.body.email));
}

export async function login(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const authService = await import('./auth.service');
  const member = await authService.login(req.body.email, req.body.password);
  await startSession(req, res, member);
  return ok(res, { member: await memberDto(member.id) });
}

export async function forgotPassword(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const authService = await import('./auth.service');
  return ok(res, await authService.forgotPassword(req.body.email));
}

export async function resetPassword(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const authService = await import('./auth.service');
  await authService.resetPassword(req.body.email, req.body.code, req.body.password);
  clearAuthCookies(res);
  return ok(res, { message: 'Password updated. Please log in.' });
}

export async function changePassword(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const authService = await import('./auth.service');
  await authService.changePassword(req.user!.sub, req.user!.sid, req.body.currentPassword, req.body.newPassword);
  return ok(res, { message: 'Password changed.' });
}

export async function refresh(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const authService = await import('./auth.service');
  const token = req.cookies?.[REFRESH_COOKIE];
  if (!token) {
    clearAuthCookies(res);
    throw Unauthorized('No refresh token');
  }
  try {
    const result = await authService.refresh(token);
    // Access-only — the refresh token/cookie is deliberately left untouched
    // (see auth.service.ts's refresh()), so it keeps counting down to its
    // original login-time expiry instead of sliding forward on every call.
    setAccessCookie(res, result.accessToken);
    return ok(res, { accessToken: result.accessToken });
  } catch (err) {
    // Refresh failed (expired/revoked/invalid token, deactivated member) —
    // the session is dead either way, so clear the stale cookies instead of
    // leaving the browser resending them on every subsequent request.
    clearAuthCookies(res);
    throw err;
  }
}

export async function logout(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const authService = await import('./auth.service');
  // Best-effort: decode the refresh cookie (if present/valid) to find this
  // device's Session row and delete it, so its tokens stop working
  // immediately instead of just at natural expiry.
  const token = req.cookies?.[REFRESH_COOKIE];
  let sessionId: string | null = null;
  if (token) {
    try {
      sessionId = verifyRefreshToken(token).sid;
    } catch {
      sessionId = null;
    }
  }
  await authService.logout(sessionId);
  clearAuthCookies(res);
  return ok(res, { message: 'Logged out' });
}

export async function logoutAll(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const authService = await import('./auth.service');
  if (req.user) await authService.logoutAll(req.user.sub);
  clearAuthCookies(res);
  return ok(res, { message: 'Logged out from all devices' });
}

// GET /auth/sessions — this account's own logged-in devices (self-service,
// works for SUPER_ADMIN too — there's no separate admin session store).
export async function listSessions(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const sessionService = await import('./session.service');
  const sessions = await sessionService.listSessions(req.user!.sub);
  return ok(res, {
    sessions: sessions.map((s) => ({
      id: s.id,
      deviceInfo: s.deviceInfo,
      userAgent: s.userAgent,
      ip: s.ip,
      lastUsedAt: s.lastUsedAt,
      createdAt: s.createdAt,
      isCurrent: s.id === req.user!.sid,
    })),
  });
}

// DELETE /auth/sessions/:id — removes one of this account's own devices. If
// it's the caller's own current device, this behaves like a logout on that
// device (its tokens stop working on their next request, same `sid` check
// as eviction) but the current request's cookies are left alone.
export async function revokeSession(req: Request, res: Response) {
  const { ok } = await import('@/core/http/response');
  const { NotFound } = await import('@/core/errors/AppError');
  const sessionService = await import('./session.service');
  const revoked = await sessionService.revokeSession(req.user!.sub, param(req, 'id'));
  if (!revoked) throw NotFound('Device session not found');
  return ok(res, { message: 'Device removed' });
}
