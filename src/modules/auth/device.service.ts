import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { env } from '@/core/config/env';
import { buildCookieBase } from '@/core/http/cookie-options';
import type { DeviceInfo } from './auth.validation';
import type { DeviceMeta } from './session.service';

export const DEVICE_COOKIE = 'dvid';
const DEVICE_COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

const cookieOpts = buildCookieBase({
  isProd: env.isProd,
  domain: env.cookieDomain,
  sameSite: env.cookieSameSite,
});

// Reuses the existing `dvid` cookie if the browser already has one — same
// physical browser keeps the same deviceId across logins and logouts (logout
// never clears this cookie, only the access/refresh ones — see cookies.ts).
// Only mints a new id the first time this browser is ever seen.
export function getOrCreateDeviceId(req: Request, res: Response): string {
  const existing = req.cookies?.[DEVICE_COOKIE];
  if (existing) return existing;
  const deviceId = crypto.randomUUID();
  res.cookie(DEVICE_COOKIE, deviceId, { ...cookieOpts, maxAge: DEVICE_COOKIE_MAX_AGE_MS });
  return deviceId;
}

export function buildDeviceMeta(req: Request, deviceInfo?: DeviceInfo): DeviceMeta {
  return {
    userAgent: req.headers['user-agent'],
    ip: req.ip,
    deviceInfo,
  };
}
