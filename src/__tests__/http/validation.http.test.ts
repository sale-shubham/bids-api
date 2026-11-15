import { bearer, getApp, resetPrismaMock } from './harness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { HARD_MAX_PRICE_PAISE } from '@/core/money';

vi.mock('@/core/prisma/client', async () => ({ prisma: (await import('./harness')).prismaMock }));
vi.mock('@/core/middleware/pgRateLimitStore', async () => ({ PgRateLimitStore: (await import('./harness')).PassStore }));
vi.mock('@/core/logger/logger', async () => ({ logger: (await import('./harness')).silentLogger }));

const NOW = new Date('2026-03-10T10:00:00.000Z');
const HOUR = 3_600_000;
const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

beforeEach(() => {
  resetPrismaMock();
  // Only Date is faked: sockets/timers that supertest relies on stay real.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
async function send(method: Method, path: string, opts: { as?: 'BIDDER' | 'AUCTIONEER' | 'SUPER_ADMIN'; body?: unknown } = {}) {
  const req = request(await getApp())[method](path);
  if (opts.as) req.set('Authorization', await bearer(opts.as, opts.as === 'SUPER_ADMIN' ? 'admin1' : 'm1'));
  return req.send((opts.body ?? {}) as object);
}

/** 400 VALIDATION_ERROR whose message / details mention `field`. */
function expectInvalid(res: request.Response, field?: string | RegExp) {
  expect(res.status).toBe(400);
  expect(res.body.success).toBe(false);
  expect(res.body.error.code).toBe('VALIDATION_ERROR');
  expect(Array.isArray(res.body.error.details)).toBe(true);
  if (field) {
    const fields = res.body.error.details.map((d: { field: string }) => d.field).join(',');
    expect(fields).toMatch(field);
  }
}

describe('auth schemas', () => {
  const signup = { name: 'Asha', email: 'asha@example.com', password: 'abcdefg1', role: 'BIDDER' };

  it.each([
    ['too short', 'abc1', /at least 8/],
    ['no digit', 'abcdefgh', /number/],
    ['no letter', '12345678', /letter/],
    ['over 72 bytes', 'a1'.repeat(37), /at most 72/],
  ])('signup rejects a password that is %s', async (_n, password, msg) => {
    const res = await send('post', '/auth/signup', { body: { ...signup, password } });
    expectInvalid(res, 'password');
    expect(res.body.error.message).toMatch(msg);
  });

  it('signup rejects SUPER_ADMIN as a self-service role, bad email and missing name', async () => {
    expectInvalid(await send('post', '/auth/signup', { body: { ...signup, role: 'SUPER_ADMIN' } }), 'role');
    expectInvalid(await send('post', '/auth/signup', { body: { ...signup, email: 'nope' } }), 'email');
    expectInvalid(await send('post', '/auth/signup', { body: { ...signup, name: undefined } }), 'name');
  });

  it('verify needs a 6-digit code', async () => {
    const res = await send('post', '/auth/signup/verify', { body: { email: 'a@example.com', code: '12ab56' } });
    expectInvalid(res, 'code');
    expect(res.body.error.message).toMatch(/6-digit/);
  });

  it('login needs email and password; reset enforces the password rule', async () => {
    expectInvalid(await send('post', '/auth/login', { body: { email: 'a@example.com' } }), 'password');
    expectInvalid(
      await send('post', '/auth/password/reset', { body: { email: 'a@example.com', code: '123456', password: 'short' } }),
      'password',
    );
  });

  it('change-password enforces the new-password rule (after the guards)', async () => {
    const res = await send('post', '/auth/password/change', {
      as: 'BIDDER',
      body: { currentPassword: 'x', newPassword: 'nodigitshere' },
    });
    expectInvalid(res, 'newPassword');
  });
});

describe('bids schemas', () => {
  it.each([
    ['non-integer', 10.5],
    ['zero', 0],
    ['negative', -100],
    ['a string', 'lots'],
    ['above HARD_MAX_PRICE_PAISE', HARD_MAX_PRICE_PAISE + 1],
    ['missing', undefined],
  ])('POST /auctions/:id/bids rejects an amount that is %s', async (_n, amountPaise) => {
    expectInvalid(await send('post', '/auctions/a1/bids', { as: 'BIDDER', body: { amountPaise } }), 'amountPaise');
  });

  it.each([
    ['page=0', 'page=0'],
    ['pageSize=101', 'pageSize=101'],
    ['page=abc', 'page=abc'],
  ])('GET /auctions/:id/bids rejects %s', async (_n, qs) => {
    expectInvalid(await send('get', `/auctions/a1/bids?${qs}`));
  });

  it('GET /bids/mine rejects an unknown tab and an oversized page', async () => {
    expectInvalid(await send('get', '/bids/mine?tab=nope', { as: 'BIDDER' }), 'tab');
    expectInvalid(await send('get', '/bids/mine?pageSize=500', { as: 'BIDDER' }), 'pageSize');
  });
});

describe('auctions schemas', () => {
  const base = {
    title: 'Vintage brass telescope',
    description: 'A fully working brass telescope in excellent condition.',
    category: 'Antiques',
    condition: 'USED',
    images: ['https://cdn.noblebid.test/auctions/a.jpg'],
    startingBidPaise: 50_000,
    startTime: iso(HOUR),
    endTime: iso(3 * HOUR),
  };
  const create = (over: Record<string, unknown>) => send('post', '/auctions', { as: 'AUCTIONEER', body: { ...base, ...over } });

  it('rejects an end time less than 1 hour after the start', async () => {
    const res = await create({ endTime: iso(HOUR + 30 * 60_000) });
    expectInvalid(res);
    expect(res.body.error.message).toMatch(/at least 1 hour/);
  });

  it('rejects a window longer than 30 days', async () => {
    const res = await create({ endTime: iso(HOUR + 31 * 24 * HOUR) });
    expectInvalid(res);
    expect(res.body.error.message).toMatch(/at most 30 days/);
  });

  it('rejects a start time in the past (beyond the 2 minute grace)', async () => {
    const res = await create({ startTime: iso(-10 * 60_000), endTime: iso(2 * HOUR) });
    expectInvalid(res);
    expect(res.body.error.message).toMatch(/cannot be in the past/);
  });

  it('rejects foreign image hosts, empty images, low starting bid, bad condition', async () => {
    expectInvalid(await create({ images: ['https://evil.example.com/x.jpg'] }), 'images');
    expectInvalid(await create({ images: [] }), 'images');
    expectInvalid(await create({ startingBidPaise: 99 }), 'startingBidPaise');
    expectInvalid(await create({ condition: 'BROKEN' }), 'condition');
    expectInvalid(await create({ title: 'abc' }), 'title');
  });

  it('PATCH needs at least one field; republish needs both times', async () => {
    expectInvalid(await send('patch', '/auctions/a1', { as: 'AUCTIONEER', body: {} }));
    expectInvalid(await send('post', '/auctions/a1/republish', { as: 'AUCTIONEER', body: { startTime: iso(HOUR) } }), 'endTime');
  });

  it.each([
    ['pageSize above max', 'pageSize=101'],
    ['page below min', 'page=0'],
    ['unknown status', 'status=archived'],
    ['unknown sort', 'sort=cheapest'],
    ['minPrice above maxPrice', 'minPrice=500&maxPrice=100'],
    ['negative minPrice', 'minPrice=-1'],
    ['unknown condition', 'condition=MINT'],
  ])('GET /auctions rejects %s', async (_n, qs) => {
    expectInvalid(await send('get', `/auctions?${qs}`));
  });

  it('GET /auctions/mine validates status and paging', async () => {
    expectInvalid(await send('get', '/auctions/mine?status=draft', { as: 'AUCTIONEER' }), 'status');
    expectInvalid(await send('get', '/auctions/mine?pageSize=0', { as: 'AUCTIONEER' }), 'pageSize');
  });
});

describe('settings / admin schemas', () => {
  const settings = { commissionRateBps: 500, minIncrementPaise: 10_000, antiSnipingMinutes: 2, categories: ['Art', 'Cars'] };
  const put = (over: Record<string, unknown>) => send('put', '/admin/settings', { as: 'SUPER_ADMIN', body: { ...settings, ...over } });

  it.each([
    ['commissionRateBps above 3000', { commissionRateBps: 3001 }, 'commissionRateBps'],
    ['negative commissionRateBps', { commissionRateBps: -1 }, 'commissionRateBps'],
    ['minIncrementPaise below 100', { minIncrementPaise: 99 }, 'minIncrementPaise'],
    ['antiSnipingMinutes above 30', { antiSnipingMinutes: 31 }, 'antiSnipingMinutes'],
    ['empty categories', { categories: [] }, 'categories'],
    ['case-insensitive duplicate categories', { categories: ['Art', 'art'] }, 'categories'],
    ['1-char category', { categories: ['A'] }, 'categories'],
  ])('PUT /admin/settings rejects %s', async (_n, over, field) => {
    expectInvalid(await put(over), field);
  });

  it('PUT /admin/settings requires every field (whole-object replace)', async () => {
    expectInvalid(await send('put', '/admin/settings', { as: 'SUPER_ADMIN', body: { commissionRateBps: 500 } }));
  });

  it('device-limit bounds are 1..20', async () => {
    expectInvalid(await send('put', '/admin/settings/device-limit', { as: 'SUPER_ADMIN', body: { memberLimit: 0, superAdminLimit: 1 } }), 'memberLimit');
    expectInvalid(await send('put', '/admin/settings/device-limit', { as: 'SUPER_ADMIN', body: { memberLimit: 1, superAdminLimit: 21 } }), 'superAdminLimit');
  });

  it('legal page: unknown slug and empty body are rejected', async () => {
    expectInvalid(await send('put', '/admin/settings/legal/not-a-page', { as: 'SUPER_ADMIN', body: { title: 'Hello', content: '<p>x</p>' } }), 'slug');
    expectInvalid(await send('put', '/admin/settings/legal/terms-conditions', { as: 'SUPER_ADMIN', body: { title: 'T' } }));
    expectInvalid(await send('get', '/settings/legal/not-a-page'), 'slug');
  });

  it.each([
    ['/admin/auctions?pageSize=101'],
    ['/admin/auctions?status=bogus'],
    ['/admin/commissions?status=bogus'],
    ['/admin/commissions?page=0'],
    ['/admin/payments?status=bogus'],
    ['/admin/members?role=OWNER'],
    ['/admin/members?sortBy=passwordHash'],
    ['/admin/members?pageSize=0'],
  ])('GET %s is rejected', async (path) => {
    expectInvalid(await send('get', path, { as: 'SUPER_ADMIN' }));
  });

  it('PATCH /admin/members/:id needs a valid, non-empty body; purge bounds are 1..365', async () => {
    expectInvalid(await send('patch', '/admin/members/m2', { as: 'SUPER_ADMIN', body: {} }));
    expectInvalid(await send('patch', '/admin/members/m2', { as: 'SUPER_ADMIN', body: { role: 'GOD' } }), 'role');
    expectInvalid(await send('post', '/admin/retention/purge', { as: 'SUPER_ADMIN', body: { otpChallengeDays: 0 } }), 'otpChallengeDays');
    expectInvalid(await send('post', '/admin/retention/purge', { as: 'SUPER_ADMIN', body: { sessionInactiveDays: 366 } }), 'sessionInactiveDays');
  });
});

describe('contact, leaderboard, watchlist, notifications, push, uploads, commissions', () => {
  const contact = { name: 'Ravi', email: 'ravi@example.com', subject: 'Question', message: 'I have a question about fees.' };

  it.each([
    ['name too short', { name: 'R' }, 'name'],
    ['bad email', { email: 'nope' }, 'email'],
    ['subject too short', { subject: 'hi' }, 'subject'],
    ['message too short', { message: 'short' }, 'message'],
    ['message too long', { message: 'x'.repeat(4001) }, 'message'],
  ])('POST /contact rejects %s', async (_n, over, field) => {
    expectInvalid(await send('post', '/contact', { body: { ...contact, ...over } }), field);
  });

  it('POST /contact rejects a missing field', async () => {
    expectInvalid(await send('post', '/contact', { body: { name: 'Ravi' } }));
  });

  it('GET /leaderboard bounds limit (1..50) and `by`', async () => {
    expectInvalid(await send('get', '/leaderboard?limit=51'), 'limit');
    expectInvalid(await send('get', '/leaderboard?limit=0'), 'limit');
    expectInvalid(await send('get', '/leaderboard?by=lucky'), 'by');
  });

  it('GET /watchlist and /notifications bound page / pageSize', async () => {
    expectInvalid(await send('get', '/watchlist?pageSize=101', { as: 'BIDDER' }), 'pageSize');
    expectInvalid(await send('get', '/watchlist?page=0', { as: 'BIDDER' }), 'page');
    expectInvalid(await send('get', '/notifications?pageSize=101', { as: 'BIDDER' }), 'pageSize');
  });

  it('GET /commissions/mine bounds status and paging', async () => {
    expectInvalid(await send('get', '/commissions/mine?status=maybe', { as: 'AUCTIONEER' }), 'status');
    expectInvalid(await send('get', '/commissions/mine?pageSize=101', { as: 'AUCTIONEER' }), 'pageSize');
  });

  it('POST /uploads/presign validates folder, content type and size', async () => {
    const ok = { folder: 'auctions', contentType: 'image/png', size: 1000 };
    expectInvalid(await send('post', '/uploads/presign', { as: 'BIDDER', body: { ...ok, folder: 'etc' } }), 'folder');
    expectInvalid(await send('post', '/uploads/presign', { as: 'BIDDER', body: { ...ok, contentType: 'application/pdf' } }), 'contentType');
    expectInvalid(await send('post', '/uploads/presign', { as: 'BIDDER', body: { ...ok, size: 6 * 1024 * 1024 } }), 'size');
  });

  it('POST /push/subscribe only accepts https endpoints with keys', async () => {
    const sub = { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'k', auth: 'a' } };
    expectInvalid(await send('post', '/push/subscribe', { as: 'BIDDER', body: { ...sub, endpoint: 'http://169.254.169.254/x' } }), 'endpoint');
    expectInvalid(await send('post', '/push/subscribe', { as: 'BIDDER', body: { endpoint: sub.endpoint } }), 'keys');
  });

  it('PATCH /members/me rejects an empty / malformed body', async () => {
    const res = await send('patch', '/members/me', { as: 'BIDDER', body: { name: 12345, phone: { x: 1 } } });
    expectInvalid(res);
  });

  it('watchlist :auctionId has no format schema: an unknown id is a 404 AUCTION_NOT_FOUND, not a 400', async () => {
    const res = await send('post', '/watchlist/not-a-real-id', { as: 'BIDDER' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('AUCTION_NOT_FOUND');
  });
});
