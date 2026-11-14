import { getApp, prismaMock, resetPrismaMock } from './harness';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('@/core/prisma/client', async () => ({ prisma: (await import('./harness')).prismaMock }));
vi.mock('@/core/middleware/pgRateLimitStore', async () => ({ PgRateLimitStore: (await import('./harness')).PassStore }));
vi.mock('@/core/logger/logger', async () => ({ logger: (await import('./harness')).silentLogger }));

beforeEach(() => {
  resetPrismaMock();
});

describe('error envelope', () => {
  it.each(['get', 'post', 'put', 'patch', 'delete'] as const)('unknown route (%s) -> 404 NOT_FOUND', async (method) => {
    const res = await request(await getApp())[method]('/definitely/not/a/route');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  it('GET /health -> { success, data: { status: "ok" } }', async () => {
    const res = await request(await getApp()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { status: 'ok' } });
  });

  it('malformed JSON -> 400 INVALID_JSON (not 500), without parser internals', async () => {
    const res = await request(await getApp())
      .post('/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": "a@example.com", ');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' },
    });
  });

  it('body over the 2mb limit -> 413 PAYLOAD_TOO_LARGE', async () => {
    const res = await request(await getApp())
      .post('/contact')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ message: 'x'.repeat(2 * 1024 * 1024 + 10) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('unexpected error -> 500 INTERNAL_ERROR with no stack, message or driver internals', async () => {
    prismaMock.appSetting.findMany.mockRejectedValue(
      new Error('connect ECONNREFUSED postgres://admin:hunter2@db.internal:5432/nb'),
    );
    const res = await request(await getApp()).get('/settings/public');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
    const raw = res.text;
    expect(raw).not.toMatch(/hunter2|ECONNREFUSED|postgres:|\bat .*\(.*:\d+:\d+\)|node_modules|stack/i);
  });

  it('a synchronous throw inside a handler chain is also a clean 500', async () => {
    prismaMock.session.findUnique.mockImplementation(() => {
      throw new Error('boom: secret-detail');
    });
    const { bearer } = await import('./harness');
    const res = await request(await getApp()).get('/members/me').set('Authorization', await bearer('BIDDER'));
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('secret-detail');
  });

  it('validation errors keep the documented shape (code, joined message, details[])', async () => {
    const res = await request(await getApp()).get('/leaderboard?limit=999&by=x');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'limit', message: expect.any(String) })]),
    );
    expect(res.body.error.message).toContain('limit:');
    // Joi quoting is stripped from messages.
    expect(res.body.error.message).not.toMatch(/"/);
  });

  it('unknown body keys are stripped rather than rejected', async () => {
    const res = await request(await getApp())
      .post('/auth/signup/verify')
      .send({ email: 'a@example.com', code: '12345', extra: 'x' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.error.details)).not.toContain('extra');
  });
});

describe('security headers', () => {
  it('helmet is on and x-powered-by is off', async () => {
    const res = await request(await getApp()).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('CORS', () => {
  const ALLOWED = 'https://app.noblebid.test';

  it('an allowed origin gets ACAO and credentials on a simple request', async () => {
    const res = await request(await getApp()).get('/health').set('Origin', ALLOWED);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-expose-headers']).toMatch(/content-disposition/i);
    expect(res.headers.vary).toMatch(/Origin/i);
  });

  it('every configured origin in the CORS_ORIGINS list is allowed', async () => {
    const res = await request(await getApp()).get('/health').set('Origin', 'http://localhost:3000');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('a disallowed origin gets no CORS headers (the request itself still runs)', async () => {
    const res = await request(await getApp()).get('/health').set('Origin', 'https://evil.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    // (`cors` emits Allow-Credentials unconditionally; without Allow-Origin the browser still blocks the read.)
    expect(res.status).toBe(200);
  });

  it('a look-alike origin (suffix / prefix match) is not allowed', async () => {
    const app = await getApp();
    for (const origin of ['https://app.noblebid.test.evil.com', 'http://app.noblebid.test', 'https://xapp.noblebid.test']) {
      const res = await request(app).get('/health').set('Origin', origin);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('preflight from an allowed origin -> 204 with methods, requested headers, 2h max-age, credentials', async () => {
    const res = await request(await getApp())
      .options('/auctions/a1/bids')
      .set('Origin', ALLOWED)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,authorization');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-methods']).toMatch(/POST/);
    expect(res.headers['access-control-allow-headers']).toMatch(/content-type/i);
    expect(res.headers['access-control-max-age']).toBe('7200');
  });

  it('preflight from a disallowed origin carries no allow-origin header', async () => {
    const res = await request(await getApp())
      .options('/auctions/a1/bids')
      .set('Origin', 'https://evil.example.com')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('error responses (401) still carry CORS headers so the browser can read them', async () => {
    const res = await request(await getApp()).get('/members/me').set('Origin', ALLOWED);
    expect(res.status).toBe(401);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
  });
});
