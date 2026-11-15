import { bearer, getApp, prismaMock, resetPrismaMock, tokenFor } from './harness';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('@/core/prisma/client', async () => ({ prisma: (await import('./harness')).prismaMock }));
vi.mock('@/core/middleware/pgRateLimitStore', async () => ({ PgRateLimitStore: (await import('./harness')).PassStore }));
vi.mock('@/core/logger/logger', async () => ({ logger: (await import('./harness')).silentLogger }));

type Route = readonly [method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string];

// Every protected route group mounted in src/routes.ts, one or more routes each.
const AUTHED: Route[] = [
  ['get', '/members/me'],
  ['patch', '/members/me'],
  ['post', '/auth/password/change'],
  ['post', '/auth/logout-all'],
  ['get', '/auth/sessions'],
  ['delete', '/auth/sessions/s1'],
  ['post', '/payments/verify'],
  ['get', '/commissions/mine'],
  ['get', '/commissions/summary'],
  ['post', '/commissions/c1/checkout'],
  ['post', '/ws/ticket'],
  ['post', '/push/subscribe'],
  ['post', '/push/unsubscribe'],
  ['post', '/uploads/presign'],
  ['get', '/auctions/mine'],
  ['post', '/auctions'],
  ['patch', '/auctions/a1'],
  ['delete', '/auctions/a1'],
  ['post', '/auctions/a1/republish'],
  ['post', '/auctions/a1/bids'],
  ['post', '/auctions/a1/buy-now'],
  ['get', '/bids/mine'],
  ['get', '/notifications'],
  ['get', '/notifications/unread-count'],
  ['post', '/notifications/read-all'],
  ['post', '/notifications/n1/read'],
  ['get', '/watchlist'],
  ['get', '/watchlist/ids'],
  ['post', '/watchlist/a1'],
  ['delete', '/watchlist/a1'],
  ['post', '/auctions/a1/review'],
  ['post', '/reviews/r1/reply'],
  ['post', '/auctions/a1/questions'],
  ['post', '/questions/q1/answer'],
  ['post', '/questions/q1/hide'],
  ['get', '/saved-searches'],
  ['post', '/saved-searches'],
  ['delete', '/saved-searches/ss1'],
  ['get', '/sales/mine'],
  ['get', '/sales/sale1'],
  ['post', '/sales/sale1/checkout'],
  ['post', '/sales/sale1/ship'],
  ['post', '/sales/sale1/confirm'],
  ['post', '/sales/sale1/dispute'],
  ['get', '/payouts/account'],
  ['post', '/payouts/account'],
];

const ADMIN: Route[] = [
  ['get', '/admin/dashboard'],
  ['get', '/admin/auctions'],
  ['get', '/admin/commissions'],
  ['post', '/admin/commissions/c1/waive'],
  ['get', '/admin/payments'],
  ['get', '/admin/members'],
  ['patch', '/admin/members/m2'],
  ['post', '/admin/retention/purge'],
  ['get', '/admin/settings'],
  ['put', '/admin/settings'],
  ['get', '/admin/settings/legal'],
  ['put', '/admin/settings/legal/terms-conditions'],
  ['get', '/admin/settings/device-limit'],
  ['put', '/admin/settings/device-limit'],
  ['get', '/admin/reviews'],
  ['patch', '/admin/reviews/r1'],
  ['get', '/admin/sales'],
  ['post', '/admin/sales/sale1/release'],
  ['post', '/admin/sales/sale1/refund'],
];

const SELLER_ONLY: Route[] = [
  ['get', '/auctions/mine'],
  ['post', '/auctions'],
  ['patch', '/auctions/a1'],
  ['delete', '/auctions/a1'],
  ['post', '/auctions/a1/republish'],
  ['post', '/reviews/r1/reply'],
  ['post', '/questions/q1/answer'],
  ['post', '/questions/q1/hide'],
  ['get', '/commissions/mine'],
  ['get', '/commissions/summary'],
  ['post', '/commissions/c1/checkout'],
  ['post', '/sales/sale1/ship'],
  ['get', '/payouts/account'],
  ['post', '/payouts/account'],
];

const BIDDER_ONLY: Route[] = [
  ['post', '/auctions/a1/bids'],
  ['post', '/auctions/a1/buy-now'],
  ['get', '/bids/mine'],
  ['post', '/auctions/a1/review'],
  ['post', '/auctions/a1/questions'],
  ['get', '/saved-searches'],
  ['post', '/saved-searches'],
  ['delete', '/saved-searches/ss1'],
  ['post', '/sales/sale1/checkout'],
  ['post', '/sales/sale1/confirm'],
  ['post', '/sales/sale1/dispute'],
];

const PUBLIC: Route[] = [
  ['get', '/health'],
  ['get', '/settings/public'],
  ['get', '/settings/legal'],
  ['get', '/leaderboard'],
  ['get', '/auctions'],
  ['get', '/auctions/categories'],
  ['get', '/auctions/a1'],
  ['get', '/auctions/a1/bids'],
  ['get', '/members/m1/public'],
  ['get', '/members/m1/reviews'],
  ['get', '/auctions/a1/questions'],
  ['get', '/push/vapid-public-key'],
  ['post', '/ws/guest-ticket'],
  ['post', '/contact'],
  ['post', '/payments/webhook'],
  ['post', '/auth/login'],
  ['post', '/auth/signup'],
  ['post', '/auth/logout'],
];

const label = ([m, p]: Route) => `${m.toUpperCase()} ${p}`;
const rows = (routes: Route[]) => routes.map((r) => [label(r), r] as const);

async function call([method, path]: Route, auth?: string) {
  const req = request(await getApp())[method](path);
  if (auth) req.set('Authorization', auth);
  return req.send({});
}

beforeEach(() => {
  resetPrismaMock();
});

describe('guards: unauthenticated', () => {
  it.each(rows([...AUTHED, ...ADMIN]))('%s -> 401 UNAUTHORIZED', async (_l, route) => {
    const res = await call(route);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } });
  });

  it.each(rows(PUBLIC))('%s is public (neither 401 nor 403)', async (_l, route) => {
    const res = await call(route);
    expect([401, 403]).not.toContain(res.status);
  });
});

describe('guards: token problems', () => {
  it('rejects a garbage bearer token', async () => {
    const res = await request(await getApp()).get('/members/me').set('Authorization', 'Bearer not.a.jwt');
    expect(res.status).toBe(401);
  });

  it('rejects a token whose session row is gone (evicted device)', async () => {
    prismaMock.session.findUnique.mockResolvedValue(null);
    const res = await request(await getApp()).get('/members/me').set('Authorization', await bearer('BIDDER'));
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/session expired/i);
  });

  it('rejects a session that belongs to a different member', async () => {
    prismaMock.session.findUnique.mockResolvedValue({ id: 's-m1', memberId: 'someone-else' });
    const res = await request(await getApp()).get('/members/me').set('Authorization', await bearer('BIDDER'));
    expect(res.status).toBe(401);
  });

  it('accepts the nb_at cookie as well as the bearer header', async () => {
    const res = await request(await getApp())
      .get('/auctions/mine?status=bogus')
      .set('Cookie', `nb_at=${await tokenFor('AUCTIONEER')}`);
    // Past authenticate + requireRole + requireActiveMember: validation is what rejects it.
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('suspended member -> 403 ACCOUNT_SUSPENDED (isActive read live from the DB)', async () => {
    prismaMock.member.findUnique.mockResolvedValue({ id: 'm1', isActive: false });
    const res = await request(await getApp()).get('/watchlist/ids').set('Authorization', await bearer('BIDDER'));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });
});

describe('guards: wrong role -> 403 FORBIDDEN', () => {
  it.each(rows(SELLER_ONLY))('BIDDER cannot %s', async (_l, route) => {
    const res = await call(route, await bearer('BIDDER'));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it.each(rows(BIDDER_ONLY))('AUCTIONEER cannot %s', async (_l, route) => {
    const res = await call(route, await bearer('AUCTIONEER'));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it.each(rows(ADMIN))('BIDDER cannot %s', async (_l, route) => {
    const res = await call(route, await bearer('BIDDER'));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it.each(rows(ADMIN))('AUCTIONEER cannot %s', async (_l, route) => {
    const res = await call(route, await bearer('AUCTIONEER'));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('SUPER_ADMIN passes the seller guard on /auctions/mine (and the active-member check is skipped)', async () => {
    const res = await request(await getApp())
      .get('/auctions/mine?status=bogus')
      .set('Authorization', await bearer('SUPER_ADMIN', 'admin1'));
    expect(res.status).toBe(400); // reached validation
  });
});
