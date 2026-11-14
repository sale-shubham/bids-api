import { bearer, getApp, prismaMock, resetPrismaMock } from './harness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('@/core/prisma/client', async () => ({ prisma: (await import('./harness')).prismaMock }));
vi.mock('@/core/middleware/pgRateLimitStore', async () => ({ PgRateLimitStore: (await import('./harness')).PassStore }));
vi.mock('@/core/logger/logger', async () => ({ logger: (await import('./harness')).silentLogger }));

// Side effects after commit: events, notifications, detail serialiser.
const doubles = vi.hoisted(() => ({
  publishAuctionEvent: vi.fn(async () => {}),
  enqueueNotification: vi.fn(async () => {}),
  buildAuctionDetail: vi.fn(async (a: { id: string }) => ({ id: a.id, title: 'Telescope' })),
  listAuctions: vi.fn(),
}));
vi.mock('@/modules/auctions/auction-events', () => ({ publishAuctionEvent: doubles.publishAuctionEvent }));
vi.mock('@/modules/notify/notify.queue', () => ({ enqueueNotification: doubles.enqueueNotification }));
vi.mock('@/modules/auctions/auction-detail.service', () => ({ buildAuctionDetail: doubles.buildAuctionDetail }));
vi.mock('@/modules/auctions/auctions.service', async (orig) => ({
  ...(await orig<object>()),
  listAuctions: doubles.listAuctions,
}));

const NOW = new Date('2026-03-10T10:00:00.000Z');
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);
const HOUR = 3_600_000;

function auctionRow(over: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    status: 'LIVE',
    deletedAt: null,
    sellerId: 'seller1',
    highestBidderId: null,
    bidCount: 0,
    startingBidPaise: 50_000,
    currentBidPaise: 0,
    minIncrementPaise: 10_000,
    startTime: at(-HOUR),
    endTime: at(HOUR),
    ...over,
  };
}

/** Wire the double for one successful-or-not bid transaction. */
function arrange(over: Record<string, unknown> = {}) {
  const row = auctionRow(over);
  prismaMock.$queryRaw.mockResolvedValue([{ id: 'a1' }]);
  prismaMock.auction.findUniqueOrThrow.mockResolvedValue(row);
  prismaMock.bid.create.mockImplementation(async ({ data }: { data: { amountPaise: number } }) => ({
    id: 'bid1',
    amountPaise: data.amountPaise,
    createdAt: NOW,
  }));
  prismaMock.auction.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...row,
    currentBidPaise: data.currentBidPaise,
    bidCount: row.bidCount + 1,
    endTime: (data.endTime as Date | undefined) ?? row.endTime,
  }));
  return row;
}

const place = async (amountPaise: number, who = 'bidder1') =>
  request(await getApp())
    .post('/auctions/a1/bids')
    .set('Authorization', await bearer('BIDDER', who))
    .send({ amountPaise });

beforeEach(() => {
  resetPrismaMock();
  for (const fn of Object.values(doubles)) fn.mockClear();
  prismaMock.member.findUnique.mockResolvedValue({ id: 'bidder1', name: 'Rahul Sharma', isActive: true });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('POST /auctions/:id/bids', () => {
  it('201 with { auction, bid, serverTime } and publishes the bid event', async () => {
    arrange();
    const res = await place(50_000);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.auction).toEqual({ id: 'a1', title: 'Telescope' });
    expect(res.body.data.bid).toEqual({
      id: 'bid1',
      amountPaise: 50_000,
      createdAt: NOW.toISOString(),
      bidderLabel: expect.any(String),
      isMe: true,
    });
    expect(res.body.data.serverTime).toBe(NOW.toISOString());
    // The bidder's full name is never exposed, only a label.
    expect(JSON.stringify(res.body)).not.toContain('Rahul Sharma');
    expect(doubles.publishAuctionEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'bid.placed', auctionId: 'a1' }));
    expect(doubles.enqueueNotification).not.toHaveBeenCalled();
  });

  it('notifies the previous highest bidder (outbid) and uses current + increment as the floor', async () => {
    arrange({ highestBidderId: 'other', bidCount: 1, currentBidPaise: 60_000 });
    prismaMock.bid.aggregate.mockResolvedValue({ _max: { amountPaise: 60_000 } });

    expect((await place(69_999)).body.error.code).toBe('BID_TOO_LOW');
    const res = await place(70_000);
    expect(res.status).toBe(201);
    expect(doubles.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'outbid', memberId: 'other', auctionId: 'a1' }),
    );
  });

  it('anti-sniping extends the end time and publishes auction.extended', async () => {
    arrange({ endTime: at(60_000) }); // 1 minute left
    prismaMock.appSetting.findUnique.mockResolvedValue({ key: 'auction.antiSnipingMinutes', value: '5' });
    const res = await place(50_000);
    expect(res.status).toBe(201);
    const types = doubles.publishAuctionEvent.mock.calls.map((c) => (c as unknown as [{ type: string }])[0].type);
    expect(types).toEqual(['bid.placed', 'auction.extended']);
  });

  const cases: [string, Record<string, unknown>, number, string, (() => void)?][] = [
    ['AUCTION_NOT_FOUND (no row)', {}, 404, 'AUCTION_NOT_FOUND', () => void prismaMock.$queryRaw.mockResolvedValue([])],
    ['AUCTION_NOT_FOUND (cancelled)', { status: 'CANCELLED' }, 404, 'AUCTION_NOT_FOUND'],
    ['AUCTION_NOT_FOUND (deleted)', { deletedAt: at(-1000) }, 404, 'AUCTION_NOT_FOUND'],
    ['AUCTION_NOT_STARTED', { startTime: at(HOUR), endTime: at(3 * HOUR) }, 409, 'AUCTION_NOT_STARTED'],
    ['AUCTION_ENDED (time passed)', { endTime: at(-1000) }, 409, 'AUCTION_ENDED'],
    ['AUCTION_ENDED (status)', { status: 'ENDED' }, 409, 'AUCTION_ENDED'],
    ['OWN_AUCTION', { sellerId: 'bidder1' }, 403, 'OWN_AUCTION'],
    ['ALREADY_HIGHEST', { highestBidderId: 'bidder1', bidCount: 1, currentBidPaise: 60_000 }, 409, 'ALREADY_HIGHEST'],
    ['BID_TOO_LOW (below starting bid)', {}, 400, 'BID_TOO_LOW'],
  ];
  it.each(cases)('maps %s', async (_n, over, status, code, tweak) => {
    arrange(over);
    tweak?.();
    const res = await place(10_000);
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ success: false, error: { code } });
    expect(prismaMock.bid.create).not.toHaveBeenCalled();
  });

  it('BID_TOO_LOW carries the minimum acceptable bid in details', async () => {
    arrange();
    const res = await place(49_999);
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual({ minBidPaise: 50_000 });
  });

  it('ACCOUNT_SUSPENDED when the member is deactivated between guard and lock', async () => {
    arrange();
    prismaMock.member.findUnique
      .mockResolvedValueOnce({ id: 'bidder1', isActive: true }) // requireActiveMember
      .mockResolvedValueOnce({ id: 'bidder1', name: 'R', isActive: false }); // inside the transaction
    const res = await place(50_000);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('a deactivated member is stopped at the guard with ACCOUNT_SUSPENDED', async () => {
    prismaMock.member.findUnique.mockResolvedValue({ id: 'bidder1', isActive: false });
    const res = await place(50_000);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});

describe('GET /auctions/:id/bids and /bids/mine', () => {
  it('lists bids with paging meta, public, label only', async () => {
    prismaMock.auction.findUnique.mockResolvedValue({
      sellerId: 'seller1', status: 'LIVE', deletedAt: null, startTime: at(-HOUR), endTime: at(HOUR),
    });
    prismaMock.bid.findMany.mockResolvedValue([
      { id: 'b2', amountPaise: 70_000, createdAt: NOW, bidder: { id: 'u2', name: 'Meera Nair' } },
      { id: 'b1', amountPaise: 60_000, createdAt: NOW, bidder: { id: 'u1', name: 'Rahul Sharma' } },
    ]);
    prismaMock.bid.count.mockResolvedValue(2);
    const res = await request(await getApp()).get('/auctions/a1/bids?pageSize=5');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta).toEqual({ total: 2, page: 1, pageSize: 5, totalPages: 1 });
    expect(JSON.stringify(res.body)).not.toMatch(/Meera|Rahul/);
  });

  it('404 AUCTION_NOT_FOUND for an unknown auction', async () => {
    prismaMock.auction.findUnique.mockResolvedValue(null);
    const res = await request(await getApp()).get('/auctions/nope/bids');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('AUCTION_NOT_FOUND');
  });

  it('GET /bids/mine -> empty paged list when the member never bid', async () => {
    prismaMock.bid.groupBy.mockResolvedValue([]);
    const res = await request(await getApp()).get('/bids/mine').set('Authorization', await bearer('BIDDER', 'bidder1'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: [], meta: { total: 0, page: 1, pageSize: 20, totalPages: 1 } });
  });
});

describe('GET /auctions', () => {
  it('returns the paged envelope with meta and a top-level serverTime; defaults are applied', async () => {
    doubles.listAuctions.mockResolvedValue({
      items: [{ id: 'a1', title: 'Telescope' }],
      meta: { total: 1, page: 1, pageSize: 20, totalPages: 1 },
    });
    const res = await request(await getApp()).get('/auctions');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: [{ id: 'a1', title: 'Telescope' }],
      meta: { total: 1, page: 1, pageSize: 20, totalPages: 1 },
      serverTime: NOW.toISOString(),
    });
    expect(doubles.listAuctions).toHaveBeenCalledWith(expect.objectContaining({ status: 'live', page: 1, pageSize: 20 }));
  });

  it('coerces and forwards query filters as typed values', async () => {
    doubles.listAuctions.mockResolvedValue({ items: [], meta: { total: 0, page: 2, pageSize: 5, totalPages: 1 } });
    await request(await getApp()).get('/auctions?status=ended&page=2&pageSize=5&minPrice=100&sort=priceAsc&q=%20brass%20');
    expect(doubles.listAuctions).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ended', page: 2, pageSize: 5, minPrice: 100, sort: 'priceAsc', q: 'brass' }),
    );
  });
});

describe('GET /auctions/:id', () => {
  it('404 AUCTION_NOT_FOUND for an unknown id', async () => {
    prismaMock.auction.findUnique.mockResolvedValue(null);
    const res = await request(await getApp()).get('/auctions/missing');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'AUCTION_NOT_FOUND', message: 'Auction not found' },
    });
  });

  it('hides a cancelled auction from the public but shows it to its seller', async () => {
    const cancelled = auctionRow({ status: 'CANCELLED' });
    prismaMock.auction.findUnique.mockResolvedValue(cancelled);
    const app = await getApp();
    expect((await request(app).get('/auctions/a1')).status).toBe(404);

    const res = await request(app).get('/auctions/a1').set('Authorization', await bearer('AUCTIONEER', 'seller1'));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ auction: { id: 'a1', title: 'Telescope' }, serverTime: NOW.toISOString() });
  });

  it('a bad token on this public route degrades to anonymous instead of 401', async () => {
    prismaMock.auction.findUnique.mockResolvedValue(auctionRow());
    const res = await request(await getApp()).get('/auctions/a1').set('Authorization', 'Bearer garbage');
    expect(res.status).toBe(200);
  });
});
