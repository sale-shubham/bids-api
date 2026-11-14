// Shared cookie attributes for every auth/device cookie. Pure (no env import) so
// it is unit-testable; env.ts supplies the parsed values.
//
// Deploy modes (see readme/flows/deployment.md):
//  (a) custom domain: COOKIE_DOMAIN=.example.com, SameSite=Lax (app.* and api.* are same-site)
//  (b) no domain yet: app proxies the API via a Next.js rewrite, COOKIE_DOMAIN empty
//      -> host-only cookie (no `domain` attribute).
//  COOKIE_SAMESITE=none is an escape hatch for true cross-site calls; browsers
//  require Secure with it, so secure is forced on.
export type CookieSameSite = 'lax' | 'none';

export function parseSameSite(raw: string | undefined): CookieSameSite {
  return raw?.trim().toLowerCase() === 'none' ? 'none' : 'lax';
}

export function parseCookieDomain(
  raw: string | undefined,
  isProd: boolean
): string | undefined {
  if (raw === undefined) return isProd ? undefined : 'localhost';
  return raw.trim() || undefined;
}

export function buildCookieBase(opts: {
  isProd: boolean;
  domain: string | undefined;
  sameSite: CookieSameSite;
}) {
  return {
    httpOnly: true,
    secure: opts.isProd || opts.sameSite === 'none',
    sameSite: opts.sameSite,
    // Omitted entirely when empty -> host-only cookie.
    ...(opts.domain ? { domain: opts.domain } : {}),
    path: '/',
  };
}
