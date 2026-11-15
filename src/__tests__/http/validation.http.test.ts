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
    // `missing` fails the or() rule (no field named); the others name the field.
    const body = { maxAmountPaise: amountPaise };
    const res = await send('post', '/auctions/a1/bids', { as: 'BIDDER', body });
    expectInvalid(res, amountPaise === undefined ? undefined : 'maxAmountPaise');
    if (amountPaise !== undefined) {
      expectInvalid(await send('post', '/auctions/a1/bids', { as: 'BIDDER', body: { amountPaise } }), 'amountPaise');
    }
  });

  it('POST /auctions/:id/bids needs maxAmountPaise or the amountPaise alias', async () => {
    expectInvalid(await send('post', '/auctions/a1/bids', { as: 'BIDDER', body: {} }));
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

  it('rejects a bad reservePricePaise / buyNowPricePaise', async () => {
    // Another member id: the create route is limited to 10 writes / minute per member.
    const res = await request(await getApp())
      .post('/auctions')
      .set('Authorization', await bearer('AUCTIONEER', 'm2'))
      .send({ ...base, reservePricePaise: 99, buyNowPricePaise: HARD_MAX_PRICE_PAISE + 1 });
    expectInvalid(res, /reservePricePaise|buyNowPricePaise/);
  });

  it('rejects foreign image hosts, empty images, low starting bid, bad condition', async () => {
    expectInvalid(await create({ images: ['https://evil.example.com/x.jpg'] }), 'images');
    expectInvalid(await create({ images: [] }), 'images');
    expectInvalid(await create({ startingBidPaise: 99 }), 'startingBidPaise');
    expectInvalid(await create({ condition: 'BROKEN' }), 'condition');
    expectInvalid(await create({ title: 'abc' }), 'title');
  });

  it('rejects a bad categoryId type, attributes shape, estimates type, videoUrl host and shippingOptions shape', async () => {
    // Own member id: create is limited to 10 writes / minute per member.
    const createAs = async (over: Record<string, unknown>) =>
      request(await getApp())
        .post('/auctions')
        .set('Authorization', await bearer('AUCTIONEER', 'm3'))
        .send({ ...base, ...over });
    const { category: _drop, ...noCategory } = base;
    expectInvalid(await request(await getApp()).post('/auctions').set('Authorization', await bearer('AUCTIONEER', 'm3')).send(noCategory));
    expectInvalid(await createAs({ attributes: 'red' }), 'attributes');
    expectInvalid(await createAs({ estimateLowPaise: 1.5 }), 'estimateLowPaise');
    expectInvalid(await createAs({ videoUrl: 'https://evil.example.com/v.mp4' }), 'videoUrl');
    expectInvalid(await createAs({ shippingOptions: 'courier' }), 'shippingOptions');
    expectInvalid(await createAs({ conditionReport: 'x'.repeat(20001) }), 'conditionReport');
  });

  it('POST /auctions/bulk needs 1..50 items; PATCH accepts the new fields', async () => {
    expectInvalid(await send('post', '/auctions/bulk', { as: 'AUCTIONEER', body: {} }), 'items');
    expectInvalid(await send('post', '/auctions/bulk', { as: 'AUCTIONEER', body: { items: [] } }), 'items');
    expectInvalid(await send('post', '/auctions/bulk', { as: 'AUCTIONEER', body: { items: Array.from({ length: 51 }, () => ({})) } }), 'items');
    expectInvalid(await send('post', '/auctions/bulk', { as: 'AUCTIONEER', body: { items: ['x'] } }), 'items');
  });

  it('GET /auctions validates sold, recentlySold, attr.<key> count and length', async () => {
    expectInvalid(await send('get', '/auctions?sold=maybe'), 'sold');
    expectInvalid(await send('get', '/auctions?condition=MINT'), 'condition');
    expectInvalid(await send('get', '/auctions?' + Array.from({ length: 6 }, (_, i) => `attr.k${i}=v`).join('&')));
    expectInvalid(await send('get', `/auctions?attr.color=${'x'.repeat(201)}`));
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

  it('POST /uploads/presign: videos only for auction-videos (mp4 / webm, 50 MB); images keep 5 MB', async () => {
    const send_ = (body: object) => send('post', '/uploads/presign', { as: 'BIDDER', body });
    expectInvalid(await send_({ folder: 'auctions', contentType: 'video/mp4', size: 1000 }), 'contentType');
    expectInvalid(await send_({ folder: 'auction-videos', contentType: 'image/png', size: 1000 }), 'contentType');
    expectInvalid(await send_({ folder: 'auction-videos', contentType: 'video/quicktime', size: 1000 }), 'contentType');
    expectInvalid(await send_({ folder: 'auction-videos', contentType: 'video/mp4', size: 50 * 1024 * 1024 + 1 }), 'size');
    expectInvalid(await send_({ folder: 'avatars', contentType: 'image/png', size: 5 * 1024 * 1024 + 1 }), 'size');
  });

  it('POST /sales/:id/checkout rejects an unknown delivery value', async () => {
    expectInvalid(await send('post', '/sales/s1/checkout', { as: 'BIDDER', body: { delivery: 'DRONE' } }), 'delivery');
  });

  it('admin categories: name, slug, parentId, attributeSchema, empty patch', async () => {
    const url = '/admin/categories';
    expectInvalid(await send('post', url, { as: 'SUPER_ADMIN', body: {} }), 'name');
    expectInvalid(await send('post', url, { as: 'SUPER_ADMIN', body: { name: 'x'.repeat(61) } }), 'name');
    expectInvalid(await send('post', url, { as: 'SUPER_ADMIN', body: { name: 'Art', slug: 'Not A Slug' } }), 'slug');
    expectInvalid(await send('post', url, { as: 'SUPER_ADMIN', body: { name: 'Art', description: 'x'.repeat(501) } }), 'description');
    expectInvalid(await send('post', url, { as: 'SUPER_ADMIN', body: { name: 'Art', attributeSchema: [{ key: 'Bad', label: 'x', type: 'text' }] } }), 'attributeSchema');
    expectInvalid(await send('post', url, { as: 'SUPER_ADMIN', body: { name: 'Art', attributeSchema: [{ key: 'a', label: 'x', type: 'select' }] } }), 'attributeSchema');
    expectInvalid(await send('patch', `${url}/c1`, { as: 'SUPER_ADMIN', body: {} }));
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

describe('reviews, questions and saved searches', () => {
  it('POST /auctions/:id/review bounds rating and comment', async () => {
    const url = '/auctions/a1/review';
    expectInvalid(await send('post', url, { as: 'BIDDER', body: {} }), 'rating');
    expectInvalid(await send('post', url, { as: 'BIDDER', body: { rating: 0 } }), 'rating');
    expectInvalid(await send('post', url, { as: 'BIDDER', body: { rating: 6 } }), 'rating');
    expectInvalid(await send('post', url, { as: 'BIDDER', body: { rating: 4.5 } }), 'rating');
    expectInvalid(await send('post', url, { as: 'BIDDER', body: { rating: 5, comment: 'x'.repeat(1001) } }), 'comment');
  });

  it('POST /reviews/:id/reply needs a non-empty reply up to 1000 chars', async () => {
    expectInvalid(await send('post', '/reviews/r1/reply', { as: 'AUCTIONEER', body: {} }), 'reply');
    expectInvalid(await send('post', '/reviews/r1/reply', { as: 'AUCTIONEER', body: { reply: '   ' } }), 'reply');
    expectInvalid(await send('post', '/reviews/r1/reply', { as: 'AUCTIONEER', body: { reply: 'x'.repeat(1001) } }), 'reply');
  });

  it('GET /members/:id/reviews bounds paging', async () => {
    expectInvalid(await send('get', '/members/m2/reviews?limit=101'), 'limit');
    expectInvalid(await send('get', '/members/m2/reviews?page=0'), 'page');
  });

  it('POST /auctions/:id/questions needs 5..500 chars', async () => {
    const url = '/auctions/a1/questions';
    expectInvalid(await send('post', url, { as: 'BIDDER', body: {} }), 'question');
    expectInvalid(await send('post', url, { as: 'BIDDER', body: { question: 'abcd' } }), 'question');
    expectInvalid(await send('post', url, { as: 'BIDDER', body: { question: 'x'.repeat(501) } }), 'question');
  });

  it('POST /questions/:id/answer needs 1..1000 chars', async () => {
    expectInvalid(await send('post', '/questions/q1/answer', { as: 'AUCTIONEER', body: {} }), 'answer');
    expectInvalid(await send('post', '/questions/q1/answer', { as: 'AUCTIONEER', body: { answer: 'x'.repeat(1001) } }), 'answer');
  });

  it('POST /saved-searches needs a criterion, min <= max and sane bounds', async () => {
    const url = '/saved-searches';
    expectInvalid(await send('post', url, { as: 'BIDDER', body: {} }));
    expectInvalid(await send('post', url, { as: 'BIDDER', body: { name: 'only a name' } }));
    expectInvalid(await send('post', url, { as: 'BIDDER', body: { minPricePaise: 500, maxPricePaise: 100 } }));
    expectInvalid(await send('post', url, { as: 'BIDDER', body: { q: 'watch', maxPricePaise: HARD_MAX_PRICE_PAISE + 1 } }), 'maxPricePaise');
    expectInvalid(await send('post', url, { as: 'BIDDER', body: { q: 'watch', minPricePaise: 1.5 } }), 'minPricePaise');
    expectInvalid(await send('post', url, { as: 'BIDDER', body: { q: 'x'.repeat(101) } }), 'q');
    expectInvalid(await send('post', url, { as: 'BIDDER', body: { q: 'watch', condition: 'BROKEN' } }), 'condition');
  });

  it('admin reviews: list filter and PATCH body', async () => {
    expectInvalid(await send('get', '/admin/reviews?hidden=maybe', { as: 'SUPER_ADMIN' }), 'hidden');
    expectInvalid(await send('get', '/admin/reviews?limit=101', { as: 'SUPER_ADMIN' }), 'limit');
    expectInvalid(await send('patch', '/admin/reviews/r1', { as: 'SUPER_ADMIN', body: {} }), 'hidden');
    expectInvalid(await send('patch', '/admin/reviews/r1', { as: 'SUPER_ADMIN', body: { hidden: 'nope' } }), 'hidden');
  });
});

describe('trust: reports', () => {
  it('POST /reports validates target, reason and details', async () => {
    const ok = { targetType: 'AUCTION', targetId: 'a1', reason: 'SPAM' };
    expectInvalid(await send('post', '/reports', { as: 'BIDDER', body: { ...ok, targetType: 'BID' } }), 'targetType');
    expectInvalid(await send('post', '/reports', { as: 'BIDDER', body: { ...ok, reason: 'RUDE' } }), 'reason');
    expectInvalid(await send('post', '/reports', { as: 'BIDDER', body: { ...ok, targetId: '' } }), 'targetId');
    expectInvalid(await send('post', '/reports', { as: 'BIDDER', body: { ...ok, details: 'x'.repeat(1001) } }), 'details');
    expectInvalid(await send('post', '/reports', { as: 'BIDDER', body: { targetType: 'AUCTION' } }));
  });

  it('admin reports: list filters, resolve status and note are bounded', async () => {
    expectInvalid(await send('get', '/admin/reports?status=DONE', { as: 'SUPER_ADMIN' }), 'status');
    expectInvalid(await send('get', '/admin/reports?targetType=BID', { as: 'SUPER_ADMIN' }), 'targetType');
    expectInvalid(await send('get', '/admin/reports?pageSize=101', { as: 'SUPER_ADMIN' }), 'pageSize');
    expectInvalid(await send('patch', '/admin/reports/r1', { as: 'SUPER_ADMIN', body: { status: 'OPEN' } }), 'status');
    expectInvalid(await send('patch', '/admin/reports/r1', { as: 'SUPER_ADMIN', body: { status: 'DISMISSED', note: 'x'.repeat(501) } }), 'note');
  });

  it('admin members PATCH accepts verified only as a boolean; browse verified filter is boolean', async () => {
    expectInvalid(await send('patch', '/admin/members/m2', { as: 'SUPER_ADMIN', body: { verified: 'maybe' } }), 'verified');
    expectInvalid(await send('get', '/auctions?verified=maybe'), 'verified');
  });
});

describe('checkout: sales, payouts, admin sales, checkout mode', () => {
  const payout = {
    legalName: 'Asha Rao',
    businessType: 'individual',
    phone: '9876543210',
    pan: 'ABCDE1234F',
    accountNumber: '123456789012',
    ifsc: 'HDFC0001234',
    beneficiaryName: 'Asha Rao',
    address: { street1: '12 MG Road', city: 'Pune', state: 'Maharashtra', postalCode: '411001' },
  };
  const create = (over: Record<string, unknown>) => send('post', '/payouts/account', { as: 'AUCTIONEER', body: { ...payout, ...over } });

  it.each([
    ['pan', { pan: 'ABCDE12345' }],
    ['ifsc', { ifsc: 'HDFC1001234' }],
    ['accountNumber', { accountNumber: '12345678' }],
    ['phone', { phone: '1234567890' }],
    ['businessType', { businessType: 'company' }],
    ['legalName', { legalName: 'x'.repeat(121) }],
    ['address', { address: { ...payout.address, postalCode: '12' } }],
  ])('POST /payouts/account rejects a bad %s', async (field, over) => {
    expectInvalid(await create(over), field);
  });

  it('GET /sales/mine bounds role, status and paging', async () => {
    expectInvalid(await send('get', '/sales/mine?role=admin', { as: 'BIDDER' }), 'role');
    expectInvalid(await send('get', '/sales/mine?status=maybe', { as: 'BIDDER' }), 'status');
    expectInvalid(await send('get', '/sales/mine?limit=101', { as: 'BIDDER' }), 'limit');
    expectInvalid(await send('get', '/sales/mine?page=0', { as: 'BIDDER' }), 'page');
  });

  it('POST /sales/:id/ship needs a method, a courier for COURIER and <= 60 char fields', async () => {
    const url = '/sales/s1/ship';
    expectInvalid(await send('post', url, { as: 'AUCTIONEER', body: {} }), 'method');
    expectInvalid(await send('post', url, { as: 'AUCTIONEER', body: { method: 'AIR' } }), 'method');
    expectInvalid(await send('post', url, { as: 'AUCTIONEER', body: { method: 'COURIER' } }), 'courier');
    expectInvalid(await send('post', url, { as: 'AUCTIONEER', body: { method: 'PICKUP', trackingNo: 'x'.repeat(61) } }), 'trackingNo');
  });

  it('POST /sales/:id/dispute needs a 10..1000 char reason', async () => {
    const url = '/sales/s1/dispute';
    expectInvalid(await send('post', url, { as: 'BIDDER', body: {} }), 'reason');
    expectInvalid(await send('post', url, { as: 'BIDDER', body: { reason: 'too short' } }), 'reason');
    expectInvalid(await send('post', url, { as: 'BIDDER', body: { reason: 'x'.repeat(1001) } }), 'reason');
  });

  it('admin sales: list filters and refund note are bounded', async () => {
    expectInvalid(await send('get', '/admin/sales?status=bogus', { as: 'SUPER_ADMIN' }), 'status');
    expectInvalid(await send('get', '/admin/sales?limit=0', { as: 'SUPER_ADMIN' }), 'limit');
    expectInvalid(await send('post', '/admin/sales/s1/refund', { as: 'SUPER_ADMIN', body: { note: 'x'.repeat(501) } }), 'note');
  });

  it('PUT /admin/settings rejects an unknown checkoutMode', async () => {
    const body = { commissionRateBps: 500, minIncrementPaise: 10_000, antiSnipingMinutes: 2, categories: ['Art', 'Cars'], checkoutMode: 'always' };
    expectInvalid(await send('put', '/admin/settings', { as: 'SUPER_ADMIN', body }), 'checkoutMode');
  });
});

describe('trust 2: deposits, strikes, risk', () => {
  it('PATCH /admin/auctions/:id/deposit needs depositPaise: an integer >= 0 or null', async () => {
    const url = '/admin/auctions/a1/deposit';
    expectInvalid(await send('patch', url, { as: 'SUPER_ADMIN', body: {} }), 'depositPaise');
    expectInvalid(await send('patch', url, { as: 'SUPER_ADMIN', body: { depositPaise: -1 } }), 'depositPaise');
    expectInvalid(await send('patch', url, { as: 'SUPER_ADMIN', body: { depositPaise: 1.5 } }), 'depositPaise');
    expectInvalid(await send('patch', url, { as: 'SUPER_ADMIN', body: { depositPaise: 'ten' } }), 'depositPaise');
  });

  it('POST /admin/strikes/:id/remove caps the note at 500 chars', async () => {
    expectInvalid(await send('post', '/admin/strikes/st1/remove', { as: 'SUPER_ADMIN', body: { note: 'x'.repeat(501) } }), 'note');
  });

  it('admin risk: list status and paging, review outcome and note are bounded', async () => {
    expectInvalid(await send('get', '/admin/risk?status=all', { as: 'SUPER_ADMIN' }), 'status');
    expectInvalid(await send('get', '/admin/risk?pageSize=101', { as: 'SUPER_ADMIN' }), 'pageSize');
    expectInvalid(await send('patch', '/admin/risk/r1', { as: 'SUPER_ADMIN', body: {} }), 'outcome');
    expectInvalid(await send('patch', '/admin/risk/r1', { as: 'SUPER_ADMIN', body: { outcome: 'OPEN' } }), 'outcome');
    expectInvalid(await send('patch', '/admin/risk/r1', { as: 'SUPER_ADMIN', body: { outcome: 'DISMISSED', note: 'x'.repeat(501) } }), 'note');
  });

  it('PUT /admin/settings bounds the deposit settings', async () => {
    const body = { commissionRateBps: 500, minIncrementPaise: 10_000, antiSnipingMinutes: 2, categories: ['Art', 'Cars'] };
    expectInvalid(await send('put', '/admin/settings', { as: 'SUPER_ADMIN', body: { ...body, depositRateBps: 99 } }), 'depositRateBps');
    expectInvalid(await send('put', '/admin/settings', { as: 'SUPER_ADMIN', body: { ...body, depositRateBps: 5001 } }), 'depositRateBps');
    expectInvalid(await send('put', '/admin/settings', { as: 'SUPER_ADMIN', body: { ...body, depositThresholdPaise: -1 } }), 'depositThresholdPaise');
  });
});

describe('engagement 2: featured, credits, invoices, GSTIN', () => {
  it('POST /auctions/:id/feature/checkout: days must be 1, 3 or 7; useCredits boolean', async () => {
    const url = '/auctions/a1/feature/checkout';
    expectInvalid(await send('post', url, { as: 'AUCTIONEER', body: {} }), 'days');
    expectInvalid(await send('post', url, { as: 'AUCTIONEER', body: { days: 2 } }), 'days');
    expectInvalid(await send('post', url, { as: 'AUCTIONEER', body: { days: 3, useCredits: 'yes' } }), 'useCredits');
  });

  it('GET /auctions/promoted bounds limit to 1..4', async () => {
    expectInvalid(await send('get', '/auctions/promoted?limit=5'), 'limit');
    expectInvalid(await send('get', '/auctions/promoted?limit=0'), 'limit');
  });

  it('POST /commissions/:id/checkout rejects a non-boolean useCredits', async () => {
    expectInvalid(await send('post', '/commissions/c1/checkout', { as: 'AUCTIONEER', body: { useCredits: 'x' } }), 'useCredits');
  });

  it('GET /members/me/credits and /invoices/mine bound paging', async () => {
    expectInvalid(await send('get', '/members/me/credits?pageSize=101', { as: 'BIDDER' }), 'pageSize');
    expectInvalid(await send('get', '/invoices/mine?page=0', { as: 'BIDDER' }), 'page');
  });

  it('POST /admin/members/:id/credits: non-zero int within 10_000_000, note 3..200', async () => {
    const url = '/admin/members/m2/credits';
    const ok = { amountPaise: 500, note: 'goodwill' };
    expectInvalid(await send('post', url, { as: 'SUPER_ADMIN', body: { ...ok, amountPaise: 0 } }), 'amountPaise');
    expectInvalid(await send('post', url, { as: 'SUPER_ADMIN', body: { ...ok, amountPaise: 10_000_001 } }), 'amountPaise');
    expectInvalid(await send('post', url, { as: 'SUPER_ADMIN', body: { ...ok, amountPaise: -10_000_001 } }), 'amountPaise');
    expectInvalid(await send('post', url, { as: 'SUPER_ADMIN', body: { ...ok, amountPaise: 1.5 } }), 'amountPaise');
    expectInvalid(await send('post', url, { as: 'SUPER_ADMIN', body: { ...ok, note: 'ab' } }), 'note');
  });

  it('GET /admin/invoices bounds type / paging', async () => {
    expectInvalid(await send('get', '/admin/invoices?type=BOGUS', { as: 'SUPER_ADMIN' }), 'type');
    expectInvalid(await send('get', '/admin/invoices?pageSize=500', { as: 'SUPER_ADMIN' }), 'pageSize');
  });

  it('PUT /admin/settings/invoice validates GSTIN, state code, rate and SAC', async () => {
    const url = '/admin/settings/invoice';
    const ok = { legalName: 'NobleBid', gstin: '27ABCDE1234F1Z5', address: 'Mumbai', stateCode: '27', gstRateBps: 1800, commissionInclusive: true, sacCode: '998599' };
    expectInvalid(await send('put', url, { as: 'SUPER_ADMIN', body: { ...ok, gstin: '123' } }), 'gstin');
    expectInvalid(await send('put', url, { as: 'SUPER_ADMIN', body: { ...ok, stateCode: '7' } }), 'stateCode');
    expectInvalid(await send('put', url, { as: 'SUPER_ADMIN', body: { ...ok, gstRateBps: 9000 } }), 'gstRateBps');
    expectInvalid(await send('put', url, { as: 'SUPER_ADMIN', body: { ...ok, sacCode: 'abc' } }), 'sacCode');
  });

  it('PATCH /members/me validates gstin and billingState; a mismatch is 400 INVALID_GSTIN', async () => {
    expectInvalid(await send('patch', '/members/me', { as: 'BIDDER', body: { gstin: 'bad' } }), 'gstin');
    expectInvalid(await send('patch', '/members/me', { as: 'BIDDER', body: { billingState: '00' } }), 'billingState');
    const res = await send('patch', '/members/me', { as: 'BIDDER', body: { gstin: '27ABCDE1234F1Z5', billingState: '29' } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_GSTIN');
  });
});

describe('engagement: follows, preferences, analytics', () => {
  it('GET /members/me/following bounds page / pageSize', async () => {
    expectInvalid(await send('get', '/members/me/following?pageSize=101', { as: 'BIDDER' }), 'pageSize');
    expectInvalid(await send('get', '/members/me/following?page=0', { as: 'BIDDER' }), 'page');
  });

  it('PUT /members/me/notification-preferences rejects unknown types, duplicates and non-booleans', async () => {
    const url = '/members/me/notification-preferences';
    const item = { type: 'outbid', email: true, push: true };
    expectInvalid(await send('put', url, { as: 'BIDDER', body: {} }), 'items');
    expectInvalid(await send('put', url, { as: 'BIDDER', body: { items: [] } }), 'items');
    expectInvalid(await send('put', url, { as: 'BIDDER', body: { items: [{ ...item, type: 'nope' }] } }), 'type');
    expectInvalid(await send('put', url, { as: 'BIDDER', body: { items: [item, item] } }), 'items');
    expectInvalid(await send('put', url, { as: 'BIDDER', body: { items: [{ ...item, push: 'maybe' }] } }), 'push');
  });

  it('following yourself is a 400 INVALID_FOLLOW', async () => {
    const res = await send('post', '/sellers/m1/follow', { as: 'AUCTIONEER' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_FOLLOW');
  });

  it('analytics days must be 7, 30 or 90', async () => {
    expectInvalid(await send('get', '/analytics/seller?days=14', { as: 'AUCTIONEER' }), 'days');
    expectInvalid(await send('get', '/analytics/auctions/a1?days=abc', { as: 'AUCTIONEER' }), 'days');
  });

  it('POST /auctions/:id/view answers 204 and ignores an unknown auction', async () => {
    const res = await send('post', '/auctions/nope/view');
    expect(res.status).toBe(204);
  });
});
