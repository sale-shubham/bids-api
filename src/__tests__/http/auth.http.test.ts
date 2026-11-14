import { getApp, resetPrismaMock } from './harness';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('@/core/prisma/client', async () => ({ prisma: (await import('./harness')).prismaMock }));
vi.mock('@/core/middleware/pgRateLimitStore', async () => ({ PgRateLimitStore: (await import('./harness')).PassStore }));
vi.mock('@/core/logger/logger', async () => ({ logger: (await import('./harness')).silentLogger }));

// DB-bound pieces of the auth flow are doubled; controller, cookie helpers,
// device cookie, token signing and issueSession() stay real.
const svc = vi.hoisted(() => ({ signup: vi.fn(), verifySignup: vi.fn(), login: vi.fn(), refresh: vi.fn() }));
vi.mock('@/modules/auth/auth.service', async (orig) => ({ ...(await orig<object>()), ...svc }));
vi.mock('@/modules/auth/session.service', async (orig) => ({
  ...(await orig<object>()),
  upsertDeviceSession: vi.fn(async (memberId: string) => ({ id: `s-${memberId}` })),
}));
vi.mock('@/modules/members/members.service', async (orig) => ({
  ...(await orig<object>()),
  getMemberDto: vi.fn(async (id: string) => ({ id, name: 'Asha', role: 'BIDDER', deviceLimit: 2 })),
}));

const member = { id: 'm1', role: 'BIDDER' as const };
const cookies = (res: request.Response): string[] => [res.headers['set-cookie'] ?? []].flat();
const cookie = (res: request.Response, name: string) => cookies(res).find((c) => c.startsWith(`${name}=`));

beforeEach(() => {
  resetPrismaMock();
  for (const fn of Object.values(svc)) fn.mockReset();
});

describe('signup -> verify -> login', () => {
  it('POST /auth/signup -> 201 { email, resendAfterSec } and sets no auth cookie', async () => {
    svc.signup.mockResolvedValue({ resendAfterSec: 30 });
    const res = await request(await getApp())
      .post('/auth/signup')
      .send({ name: 'Asha', email: 'ASHA@Example.com ', password: 'abcdefg1', role: 'BIDDER' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, data: { email: 'asha@example.com', resendAfterSec: 30 } });
    // The validated (trimmed + lower-cased) body reaches the service.
    expect(svc.signup).toHaveBeenCalledWith(expect.objectContaining({ email: 'asha@example.com', role: 'BIDDER' }));
    expect(cookie(res, 'nb_at')).toBeUndefined();
  });

  it('POST /auth/signup maps EMAIL_TAKEN to 409', async () => {
    const { EmailTaken } = await import('@/modules/auth/auth.service');
    svc.signup.mockRejectedValue(EmailTaken());
    const res = await request(await getApp())
      .post('/auth/signup')
      .send({ name: 'Asha', email: 'asha@example.com', password: 'abcdefg1', role: 'BIDDER' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('POST /auth/signup/verify -> 200, member DTO and session cookies (httpOnly, Lax, host-only)', async () => {
    svc.verifySignup.mockResolvedValue(member);
    const res = await request(await getApp()).post('/auth/signup/verify').send({ email: 'asha@example.com', code: '123456' });

    expect(res.status).toBe(200);
    expect(res.body.data.member).toMatchObject({ id: 'm1', role: 'BIDDER' });

    const at = cookie(res, 'nb_at')!;
    const rt = cookie(res, 'nb_rt')!;
    const dv = cookie(res, 'dvid')!;
    expect(at && rt && dv).toBeTruthy();
    for (const c of [at, rt, dv]) {
      expect(c).toMatch(/;\s*HttpOnly/i);
      expect(c).toMatch(/;\s*SameSite=Lax/i);
      expect(c).toMatch(/;\s*Path=\//i);
      expect(c).not.toMatch(/;\s*Domain=/i); // COOKIE_DOMAIN is empty -> host-only
      expect(c).not.toMatch(/;\s*Secure/i); // non-production, SameSite=Lax
    }
    // Access cookie is a short-lived Max-Age cookie; the refresh cookie has an absolute Expires.
    expect(at).toMatch(/Expires=/i);
    expect(rt).toMatch(/Expires=/i);
  });

  it('the access cookie issued at verify authenticates the next request', async () => {
    svc.verifySignup.mockResolvedValue(member);
    const app = await getApp();
    const res = await request(app).post('/auth/signup/verify').send({ email: 'asha@example.com', code: '123456' });
    const nbAt = cookie(res, 'nb_at')!.split(';')[0];
    const me = await request(app).get('/auth/sessions').set('Cookie', nbAt);
    // Passed authenticate (session lookup is the default double); listSessions is the handler.
    expect(me.status).not.toBe(401);
  });

  it('POST /auth/login -> 200 + cookies; an existing dvid cookie is reused, not re-issued', async () => {
    svc.login.mockResolvedValue(member);
    const res = await request(await getApp())
      .post('/auth/login')
      .set('Cookie', 'dvid=device-123')
      .send({ email: 'asha@example.com', password: 'whatever', deviceInfo: { browser: 'Chrome', os: 'Win' } });
    expect(res.status).toBe(200);
    expect(cookie(res, 'nb_at')).toMatch(/HttpOnly/i);
    expect(cookie(res, 'nb_rt')).toBeDefined();
    expect(cookie(res, 'dvid')).toBeUndefined();
    expect(svc.login).toHaveBeenCalledWith('asha@example.com', 'whatever');
  });

  it.each([
    ['InvalidCredentials', 401, 'INVALID_CREDENTIALS'],
    ['EmailNotVerified', 403, 'EMAIL_NOT_VERIFIED'],
    ['AccountSuspended', 403, 'ACCOUNT_SUSPENDED'],
  ] as const)('POST /auth/login maps %s -> %i %s and sets no cookie', async (factory, status, code) => {
    const mod = await import('@/modules/auth/auth.service');
    svc.login.mockRejectedValue(mod[factory]());
    const res = await request(await getApp()).post('/auth/login').send({ email: 'a@example.com', password: 'x' });
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ success: false, error: { code } });
    expect(cookie(res, 'nb_at')).toBeUndefined();
  });
});

describe('refresh / logout cookie handling', () => {
  it('POST /auth/refresh without a cookie -> 401 and clears the auth cookies', async () => {
    const res = await request(await getApp()).post('/auth/refresh');
    expect(res.status).toBe(401);
    expect(cookie(res, 'nb_at')).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(cookie(res, 'nb_rt')).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it('POST /auth/refresh rotates only the access cookie', async () => {
    svc.refresh.mockResolvedValue({ accessToken: 'new-access-token' });
    const res = await request(await getApp()).post('/auth/refresh').set('Cookie', 'nb_rt=anything');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ accessToken: 'new-access-token' });
    expect(cookie(res, 'nb_at')).toMatch(/^nb_at=new-access-token/);
    expect(cookie(res, 'nb_rt')).toBeUndefined();
  });

  it('POST /auth/logout always answers 200 and expires both cookies with the same attributes', async () => {
    const res = await request(await getApp()).post('/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ message: 'Logged out' });
    for (const name of ['nb_at', 'nb_rt']) {
      const c = cookie(res, name)!;
      expect(c).toMatch(/Expires=Thu, 01 Jan 1970/);
      expect(c).toMatch(/HttpOnly/i);
      expect(c).not.toMatch(/Domain=/i);
    }
  });
});

describe('cookie flags with COOKIE_DOMAIN and SameSite=None', () => {
  it('sets Domain, and forces Secure for SameSite=None', async () => {
    vi.resetModules();
    process.env.COOKIE_DOMAIN = '.noblebid.test';
    process.env.COOKIE_SAMESITE = 'none';
    try {
      const { createApp } = await import('@/app');
      const { upsertDeviceSession } = await import('@/modules/auth/session.service');
      vi.mocked(upsertDeviceSession).mockResolvedValue({ id: 's-m1' } as never);
      const { verifySignup } = await import('@/modules/auth/auth.service');
      vi.mocked(verifySignup).mockResolvedValue(member as never);
      const res = await request(createApp()).post('/auth/signup/verify').send({ email: 'a@example.com', code: '123456' });
      expect(res.status).toBe(200);
      const at = cookie(res, 'nb_at')!;
      expect(at).toMatch(/Domain=\.?noblebid\.test/i);
      expect(at).toMatch(/SameSite=None/i);
      expect(at).toMatch(/;\s*Secure/i);
    } finally {
      process.env.COOKIE_DOMAIN = '';
      process.env.COOKIE_SAMESITE = '';
    }
  });
});
