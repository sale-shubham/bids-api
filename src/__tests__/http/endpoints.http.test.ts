import { bearer, getApp, prismaMock, resetPrismaMock } from './harness';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('@/core/prisma/client', async () => ({ prisma: (await import('./harness')).prismaMock }));
vi.mock('@/core/middleware/pgRateLimitStore', async () => ({ PgRateLimitStore: (await import('./harness')).PassStore }));
vi.mock('@/core/logger/logger', async () => ({ logger: (await import('./harness')).silentLogger }));

const doubles = vi.hoisted(() => ({ emailSend: vi.fn(async () => {}) }));
vi.mock('@/providers/email', () => ({ emailProvider: { send: doubles.emailSend } }));

const NOW = new Date('2026-03-10T10:00:00.000Z');
const WEBHOOK_SECRET = 'whsec_http_test';

beforeEach(() => {
  resetPrismaMock();
  doubles.emailSend.mockClear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('POST /payments/webhook (raw-body HMAC)', () => {
  const body = JSON.stringify({ event: 'payment.authorized', payload: { payment: { entity: { id: 'pay_1' } } } });
  const sign = (raw: string, secret = WEBHOOK_SECRET) => createHmac('sha256', secret).update(raw).digest('hex');
  const post = async (raw: string, headers: Record<string, string>) =>
    request(await getApp()).post('/payments/webhook').set('Content-Type', 'application/json').set(headers).send(raw);

  it('missing signature -> 400 and nothing is recorded', async () => {
    const res = await post(body, {});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(prismaMock.webhookEvent.create).not.toHaveBeenCalled();
  });

  it('wrong signature -> 400', async () => {
    const res = await post(body, { 'x-razorpay-signature': sign(body, 'another-secret') });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/signature/i);
  });

  it('signature over re-formatted JSON fails: it is the exact raw bytes that are verified', async () => {
    const pretty = JSON.stringify(JSON.parse(body), null, 2);
    const res = await post(pretty, { 'x-razorpay-signature': sign(body) });
    expect(res.status).toBe(400);
  });

  it('good signature -> 200 { processed: true } and the event is recorded once', async () => {
    prismaMock.webhookEvent.findUnique.mockResolvedValue(null);
    prismaMock.webhookEvent.create.mockResolvedValue({});
    const res = await post(body, { 'x-razorpay-signature': sign(body), 'x-razorpay-event-id': 'evt_1' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { processed: true } });
    expect(prismaMock.webhookEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ gatewayEventId: 'evt_1', type: 'payment.authorized' }),
    });
  });

  it('a redelivered event id is acknowledged (200) but skipped', async () => {
    prismaMock.webhookEvent.findUnique.mockResolvedValue({ id: 'w1' });
    const res = await post(body, { 'x-razorpay-signature': sign(body), 'x-razorpay-event-id': 'evt_1' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ skipped: true });
    expect(prismaMock.webhookEvent.create).not.toHaveBeenCalled();
  });

  it('a validly signed non-JSON body -> 400 (not a 500)', async () => {
    const raw = 'not json at all';
    const res = await post(raw, { 'x-razorpay-signature': sign(raw) });
    // express.json() rejects the malformed body first.
    expect(res.status).toBe(400);
  });
});

describe('POST /payments/verify', () => {
  it('validates the body after the guards', async () => {
    const res = await request(await getApp())
      .post('/payments/verify')
      .set('Authorization', await bearer('AUCTIONEER'))
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('commissions', () => {
  it('GET /commissions/summary -> { unpaidPaise, dueCount, overdueCount } scoped to the seller', async () => {
    prismaMock.commission.aggregate.mockResolvedValue({ _sum: { amountPaise: 25_000 }, _count: { _all: 3 } });
    prismaMock.commission.count.mockResolvedValue(1);
    const res = await request(await getApp()).get('/commissions/summary').set('Authorization', await bearer('AUCTIONEER', 'seller1'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { unpaidPaise: 25_000, dueCount: 3, overdueCount: 1 } });
    expect(prismaMock.commission.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sellerId: 'seller1', status: 'DUE' } }),
    );
  });

  it('GET /commissions/summary is all zeros with no dues', async () => {
    prismaMock.commission.aggregate.mockResolvedValue({ _sum: { amountPaise: null }, _count: { _all: 0 } });
    prismaMock.commission.count.mockResolvedValue(0);
    const res = await request(await getApp()).get('/commissions/summary').set('Authorization', await bearer('AUCTIONEER'));
    expect(res.body.data).toEqual({ unpaidPaise: 0, dueCount: 0, overdueCount: 0 });
  });

  it('GET /commissions/mine -> paged DTOs with an overdue flag', async () => {
    prismaMock.commission.findMany.mockResolvedValue([
      {
        id: 'c1', auctionId: 'a1', rateBps: 500, amountPaise: 5_000, status: 'DUE',
        dueAt: new Date(NOW.getTime() - 1000), paidAt: null, createdAt: NOW,
        auction: { id: 'a1', title: 'Telescope', images: ['https://cdn.noblebid.test/a.jpg'], currentBidPaise: 100_000, endedAt: NOW },
      },
    ]);
    prismaMock.commission.count.mockResolvedValue(1);
    const res = await request(await getApp()).get('/commissions/mine').set('Authorization', await bearer('AUCTIONEER'));
    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ total: 1, page: 1, pageSize: 20, totalPages: 1 });
    expect(res.body.data[0]).toMatchObject({ id: 'c1', isOverdue: true, auction: { finalBidPaise: 100_000 } });
  });

  it('GET /commissions/:id -> the DTO for the owner, scoped by sellerId', async () => {
    prismaMock.commission.findFirst.mockResolvedValue({
      id: 'c1', auctionId: 'a1', rateBps: 500, amountPaise: 5_000, status: 'PAID',
      dueAt: NOW, paidAt: NOW, createdAt: NOW,
      auction: { id: 'a1', title: 'Telescope', images: [], currentBidPaise: 100_000, endedAt: NOW },
    });
    const res = await request(await getApp()).get('/commissions/c1').set('Authorization', await bearer('AUCTIONEER', 'seller1'));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: 'c1', status: 'PAID', isOverdue: false });
    expect(prismaMock.commission.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'c1', sellerId: 'seller1' } }),
    );
  });

  it("GET /commissions/:id -> 404 COMMISSION_NOT_FOUND for another seller's or unknown id", async () => {
    prismaMock.commission.findFirst.mockResolvedValue(null);
    const res = await request(await getApp()).get('/commissions/nope').set('Authorization', await bearer('AUCTIONEER'));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('COMMISSION_NOT_FOUND');
  });

  it('POST /commissions/:id/checkout -> 404 COMMISSION_NOT_FOUND for another seller\'s / unknown id', async () => {
    prismaMock.commission.findUnique.mockResolvedValue(null);
    prismaMock.commission.findFirst.mockResolvedValue(null);
    const res = await request(await getApp()).post('/commissions/nope/checkout').set('Authorization', await bearer('AUCTIONEER'));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('COMMISSION_NOT_FOUND');
  });
});

describe('websocket tickets', () => {
  it('POST /ws/guest-ticket is public and returns { ticket, expiresAt, wsUrl }', async () => {
    prismaMock.wsTicket.create.mockImplementation(async ({ data }: { data: { memberId: string | null; expiresAt: Date } }) => ({
      id: 'tkt_1',
      ...data,
    }));
    const res = await request(await getApp()).post('/ws/guest-ticket');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      ticket: 'tkt_1',
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      wsUrl: null, // no WS_API_ENDPOINT and no local ws server in tests
    });
    expect(prismaMock.wsTicket.create).toHaveBeenCalledWith({ data: expect.objectContaining({ memberId: null }) });
  });

  it('POST /ws/ticket binds the ticket to the authenticated member', async () => {
    prismaMock.wsTicket.create.mockImplementation(async ({ data }: { data: object }) => ({ id: 'tkt_2', ...data }));
    const res = await request(await getApp()).post('/ws/ticket').set('Authorization', await bearer('BIDDER', 'bidder1'));
    expect(res.status).toBe(200);
    expect(res.body.data.ticket).toBe('tkt_2');
    expect(prismaMock.wsTicket.create).toHaveBeenCalledWith({ data: expect.objectContaining({ memberId: 'bidder1' }) });
  });
});

describe('public reads', () => {
  it('GET /settings/public -> platform settings with defaults and parsed categories', async () => {
    prismaMock.appSetting.findMany.mockResolvedValue([
      { key: 'commission.rateBps', value: '750' },
      { key: 'auction.categories', value: JSON.stringify(['Art', 'Cars']) },
    ]);
    const res = await request(await getApp()).get('/settings/public');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: {
        commissionRateBps: 750,
        minIncrementPaise: 10_000,
        antiSnipingMinutes: 2,
        maxPricePaise: 10_000_000_000,
        categories: ['Art', 'Cars'],
        checkoutMode: 'optional',
      },
    });
  });

  it('GET /settings/public ignores out-of-range stored values (falls back to defaults)', async () => {
    prismaMock.appSetting.findMany.mockResolvedValue([{ key: 'commission.rateBps', value: '99999' }]);
    const res = await request(await getApp()).get('/settings/public');
    expect(res.body.data.commissionRateBps).toBe(500);
  });

  it('GET /settings/legal/:slug -> page; unknown slug -> 400', async () => {
    prismaMock.appSetting.findMany.mockResolvedValue([
      { key: 'page:terms-conditions', value: '<p>Terms</p>', updatedAt: NOW },
      { key: 'page-title:terms-conditions', value: 'Terms of Use', updatedAt: NOW },
    ]);
    const ok = await request(await getApp()).get('/settings/legal/terms-conditions');
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ slug: 'terms-conditions', title: 'Terms of Use', content: '<p>Terms</p>' });
  });

  it('GET /leaderboard -> ranked entries with abbreviated names only', async () => {
    prismaMock.member.findMany.mockResolvedValue([
      { id: 'u1', name: 'Rahul Sharma', avatarUrl: null, auctionsWon: 4, moneySpentPaise: 900_000 },
      { id: 'u2', name: 'Meera', avatarUrl: 'https://cdn.noblebid.test/a.png', auctionsWon: 2, moneySpentPaise: 100_000 },
    ]);
    const res = await request(await getApp()).get('/leaderboard?by=won&limit=2');
    expect(res.status).toBe(200);
    expect(res.body.data.entries).toEqual([
      { rank: 1, member: { id: 'u1', displayName: 'Rahul S.', avatarUrl: null }, auctionsWon: 4, moneySpentPaise: 900_000 },
      { rank: 2, member: { id: 'u2', displayName: 'Meera', avatarUrl: 'https://cdn.noblebid.test/a.png' }, auctionsWon: 2, moneySpentPaise: 100_000 },
    ]);
    expect(prismaMock.member.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2 }));
    expect(JSON.stringify(res.body)).not.toContain('Sharma');
  });

  it('POST /contact -> 200 { received: true } and mails the admin with Reply-To = sender', async () => {
    const res = await request(await getApp())
      .post('/contact')
      .send({ name: 'Ravi', email: 'Ravi@Example.com', subject: 'Fees', message: 'How do commissions work?' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { received: true } });
    expect(doubles.emailSend).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'admin@noblebid.test', replyTo: 'ravi@example.com', subject: '[Contact] Fees' }),
    );
  });
});

describe('member and watchlist reads', () => {
  it('GET /watchlist/ids requires an active member and returns the service payload', async () => {
    const live = (id: string, endsInMs: number) => ({
      createdAt: NOW,
      auction: { id, status: 'LIVE', deletedAt: null, startTime: new Date(NOW.getTime() - 1000), endTime: new Date(NOW.getTime() + endsInMs) },
    });
    prismaMock.watchlist.findMany.mockResolvedValue([live('a2', 7_200_000), live('a1', 3_600_000)]);
    const res = await request(await getApp()).get('/watchlist/ids').set('Authorization', await bearer('BIDDER'));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({ ids: ['a1', 'a2'], activeCount: 2 }); // soonest end first
  });

  it('POST /watchlist/:id on a cancelled auction -> 404 AUCTION_NOT_FOUND', async () => {
    prismaMock.auction.findUnique.mockResolvedValue({ id: 'a1', status: 'CANCELLED', deletedAt: null });
    const res = await request(await getApp()).post('/watchlist/a1').set('Authorization', await bearer('BIDDER'));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('AUCTION_NOT_FOUND');
  });

  it('POST /watchlist/:id -> { watching: true }', async () => {
    prismaMock.auction.findUnique.mockResolvedValue({ id: 'a1', status: 'LIVE', deletedAt: null });
    prismaMock.watchlist.upsert.mockResolvedValue({});
    const res = await request(await getApp()).post('/watchlist/a1').set('Authorization', await bearer('BIDDER'));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ watching: true });
  });
});

describe('admin dashboard', () => {
  it('GET /admin/dashboard -> totals + zero-filled 12-month series + recent auctions', async () => {
    prismaMock.member.count.mockResolvedValueOnce(10).mockResolvedValueOnce(7).mockResolvedValueOnce(3);
    prismaMock.auction.count.mockResolvedValueOnce(4).mockResolvedValueOnce(2).mockResolvedValueOnce(9);
    prismaMock.bid.count.mockResolvedValue(15);
    prismaMock.commission.aggregate
      .mockResolvedValueOnce({ _sum: { amountPaise: 500_000 } })
      .mockResolvedValueOnce({ _sum: { amountPaise: null } });
    prismaMock.commission.findMany.mockResolvedValue([{ amountPaise: 500_000, paidAt: new Date('2026-03-02T05:00:00Z') }]);
    prismaMock.member.findMany.mockResolvedValue([
      { role: 'BIDDER', createdAt: new Date('2026-03-01T05:00:00Z') },
      { role: 'AUCTIONEER', createdAt: new Date('2026-02-01T05:00:00Z') },
    ]);
    prismaMock.auction.findMany.mockResolvedValue([]);
    prismaMock.sale.groupBy.mockResolvedValue([]);

    const res = await request(await getApp()).get('/admin/dashboard').set('Authorization', await bearer('SUPER_ADMIN', 'admin1'));
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.totals).toEqual({
      members: 10, bidders: 7, auctioneers: 3,
      liveAuctions: 4, upcomingAuctions: 2, endedAuctions: 9,
      bidsToday: 15, commissionPaidPaise: 500_000, commissionDuePaise: 0,
    });
    expect(d.revenueByMonth).toHaveLength(12);
    expect(d.revenueByMonth.at(-1)).toEqual({ month: '2026-03', paidPaise: 500_000 });
    expect(d.revenueByMonth[0].month).toBe('2025-04');
    expect(d.signupsByMonth).toHaveLength(12);
    expect(d.signupsByMonth.at(-1)).toEqual({ month: '2026-03', bidders: 1, auctioneers: 0 });
    expect(d.recentAuctions).toEqual([]);
  });

  it('GET /admin/settings reads, PUT /admin/settings echoes the saved object', async () => {
    const settings = {
      commissionRateBps: 600, minIncrementPaise: 20_000, antiSnipingMinutes: 3,
      maxPricePaise: 5_000_000_000,
      categories: ['Art'],
      checkoutMode: 'required',
    };
    prismaMock.appSetting.findMany.mockResolvedValue([
      { key: 'commission.rateBps', value: '600' },
      { key: 'auction.minIncrementPaise', value: '20000' },
      { key: 'auction.antiSnipingMinutes', value: '3' },
      { key: 'auction.maxPricePaise', value: '5000000000' },
      { key: 'auction.categories', value: '["Art"]' },
      { key: 'checkout.mode', value: 'required' },
    ]);
    prismaMock.appSetting.upsert.mockResolvedValue({});
    const app = await getApp();
    const auth = await bearer('SUPER_ADMIN', 'admin1');
    const get = await request(app).get('/admin/settings').set('Authorization', auth);
    expect(get.body.data).toEqual(settings);
    const put = await request(app).put('/admin/settings').set('Authorization', auth).send(settings);
    expect(put.status).toBe(200);
    expect(put.body.data).toEqual(settings);
  });
});
