import type { Response } from 'express';
import { env } from '@/core/config/env';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '@/core/middleware/auth';
import { ACCESS_TTL_MS } from '@/modules/auth/token.service';

const base = {
  httpOnly: true,
  secure: env.isProd,
  sameSite: 'lax' as const,
  domain: env.cookieDomain,
  path: '/',
};

export function setAuthCookies(
  res: Response,
  accessToken: string,
  refreshToken: string,
  refreshExpiresAt: Date,
) {
  res.cookie(ACCESS_COOKIE, accessToken, { ...base, maxAge: ACCESS_TTL_MS });
  // path: '/' (not '/auth') — the frontend's edge middleware (Next.js
  // src/middleware.ts) needs this cookie on every page request (/dashboard,
  // /auctions, etc.) to attempt a refresh when the access cookie has
  // expired. Scoping it to /auth would mean the browser only ever attaches
  // it to requests whose URL path starts with /auth, which none of the
  // frontend's pages do — the middleware would never see it at all.
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...base,
    expires: refreshExpiresAt,
  });
}

// Refresh only rotates the access token, never the refresh token (see
// auth.service.ts's refresh()) — this sets just the nb_at cookie, leaving
// whatever nb_rt cookie the browser already has (from login) untouched, so
// its original expiry keeps counting down instead of being pushed out again.
export function setAccessCookie(res: Response, accessToken: string) {
  res.cookie(ACCESS_COOKIE, accessToken, { ...base, maxAge: ACCESS_TTL_MS });
}

export function clearAuthCookies(res: Response) {
  res.clearCookie(ACCESS_COOKIE, { ...base });
  res.clearCookie(REFRESH_COOKIE, { ...base });
}
