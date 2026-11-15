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
    startingBidPaise: 50_000n,
    currentBidPaise: 0n,
    minIncrementPaise: 10_000n,
    reservePricePaise: null,
    buyNowPricePaise: null,
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
  let n = 0;
  prismaMock.bid.create.mockImplementation(async ({ data }: { data: { amountPaise: number; kind: string } }) => ({
    id: `bid${++n}`,
    amountPaise: BigInt(data.amountPaise),
    kind: data.kind,
    createdAt: NOW,
  }));
  prismaMock.auction.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...row,
    currentBidPaise: data.currentBidPaise === undefined ? row.currentBidPaise : BigInt(data.currentBidPaise as number),
    highestBidderId: data.highestBidderId,
    bidCount: row.bidCount + ((data.bidCount as { increment: number } | undefined)?.increment ?? 0),
    endTime: (data.endTime as Date | undefined) ?? row.endTime,
  }));
  return row;
}

const place = async (value: number, who = 'bidder1', field: 'maxAmountPaise' | 'amountPaise' = 'maxAmountPaise') =>
  request(await getApp())
    .post('/auctions/a1/bids')
    .set('Authorization', await bearer('BIDDER', who))
    .send({ [field]: value });

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
  it('201 with { auction, bid, serverTime, outbidByProxy } and publishes the bid event', async () => {
    arrange();
    const res = await place(50_000);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.auction).toEqual({ id: 'a1', title: 'Telescope' });
    expect(res.body.data.bid).toEqual({
      id: 'bid1',
      amountPaise: 50_000,
      kind: 'MANUAL',
      createdAt: NOW.toISOString(),
      bidderLabel: expect.any(String),
      isMe: true,
    });
    expect(res.body.data.serverTime).toBe(NOW.toISOString());
    expect(res.body.data.outbidByProxy).toBe(false);
    // The bidder's full name is never exposed, only a label.
    expect(JSON.stringify(res.body)).not.toContain('Rahul Sharma');
    expect(doubles.publishAuctionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'bid.placed',
        auctionId: 'a1',
        bidCount: 1,
        currentBidPaise: 50_000,
        reserveMet: true,
        bid: expect.objectContaining({ kind: 'MANUAL' }),
      }),
    );
    expect(doubles.enqueueNotification).not.toHaveBeenCalled();
  });

  it('notifies the previous highest bidder (outbid) and uses current + increment as the floor', async () => {
    arrange({ highestBidderId: 'other', bidCount: 1, currentBidPaise: 60_000n });

    expect((await place(69_999)).body.error.code).toBe('BID_TOO_LOW');
    const res = await place(70_000);
    expect(res.status).toBe(201);
    expect(doubles.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'outbid',
        memberId: 'other',
        auctionId: 'a1',
        data: { newBidPaise: 70_000, yourBidPaise: 60_000 },
      }),
    );
  });

  it('accepts the amountPaise alias as the max', async () => {
    arrange();
    const res = await place(50_000, 'bidder1', 'amountPaise');
    expect(res.status).toBe(201);
    expect(prismaMock.maxBid.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { maxAmountPaise: 50_000 } }));
  });

  it('a first bid with a high max is recorded at the starting bid; the max stays private', async () => {
    arrange();
    const res = await place(400_000);
    expect(res.status).toBe(201);
    expect(res.body.data.bid.amountPaise).toBe(50_000);
    expect(prismaMock.maxBid.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ maxAmountPaise: 400_000 }) }),
    );
    expect(JSON.stringify(res.body)).not.toContain('400000');
  });

  it('outbid by the leader proxy: two rows, two events, outbidByProxy, no notification', async () => {
    arrange({ highestBidderId: 'other', bidCount: 2, currentBidPaise: 60_000n });
    prismaMock.maxBid.findUnique.mockResolvedValue({ maxAmountPaise: 500_000n });
    const res = await place(100_000);
    expect(res.status).toBe(201);
    expect(res.body.data.outbidByProxy).toBe(true);
    expect(res.body.data.bid).toMatchObject({ amountPaise: 100_000, kind: 'MANUAL', isMe: true });
    const created = prismaMock.bid.create.mock.calls.map((c: [{ data: Record<string, unknown> }]) => c[0].data);
    expect(created).toEqual([
      expect.objectContaining({ bidderId: 'bidder1', amountPaise: 100_000, kind: 'MANUAL' }),
      expect.objectContaining({ bidderId: 'other', amountPaise: 110_000, kind: 'AUTO' }),
    ]);
    expect(prismaMock.auction.update.mock.calls[0][0].data).toMatchObject({
      currentBidPaise: 110_000,
      highestBidderId: 'other',
      bidCount: { increment: 2 },
    });
    const events = doubles.publishAuctionEvent.mock.calls.map((c) => (c as unknown as [Record<string, unknown>])[0]);
    expect(events.map((e) => [e.type, e.currentBidPaise, e.bidCount, e.highestBidderId, e.previousHighestBidderId])).toEqual([
      ['bid.placed', 100_000, 3, 'bidder1', null],
      ['bid.placed', 110_000, 4, 'other', null],
    ]);
    expect(doubles.enqueueNotification).not.toHaveBeenCalled();
  });

  it('taking the lead over a proxy leader: AUTO row first, then the bid; the last event hands over the lead', async () => {
    arrange({ highestBidderId: 'other', bidCount: 2, currentBidPaise: 60_000n });
    prismaMock.maxBid.findUnique.mockResolvedValue({ maxAmountPaise: 100_000n });
    const res = await place(300_000);
    expect(res.body.data.outbidByProxy).toBe(false);
    const events = doubles.publishAuctionEvent.mock.calls.map((c) => (c as unknown as [Record<string, unknown>])[0]);
    expect(events.map((e) => [e.currentBidPaise, e.highestBidderId, e.previousHighestBidderId])).toEqual([
      [100_000, 'other', null],
      [110_000, 'bidder1', 'other'],
    ]);
    expect(doubles.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'outbid', memberId: 'other', data: { newBidPaise: 110_000, yourBidPaise: 100_000 } }),
    );
  });

  it('the leader raising their max: 201, no bid row, bid null', async () => {
    arrange({ highestBidderId: 'bidder1', bidCount: 1, currentBidPaise: 60_000n });
    prismaMock.maxBid.findUnique.mockResolvedValue({ maxAmountPaise: 100_000n });
    const res = await place(200_000);
    expect(res.status).toBe(201);
    expect(res.body.data.bid).toBeNull();
    expect(prismaMock.bid.create).not.toHaveBeenCalled();
    expect(doubles.publishAuctionEvent).not.toHaveBeenCalled();
  });

  it('MAX_TOO_LOW when the leader does not raise their max', async () => {
    arrange({ highestBidderId: 'bidder1', bidCount: 1, currentBidPaise: 60_000n });
    prismaMock.maxBid.findUnique.mockResolvedValue({ maxAmountPaise: 100_000n });
    const res = await place(100_000);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'MAX_TOO_LOW', details: { currentMaxPaise: 100_000 } });
  });

  it('reserveMet flips on the event once a bid reaches the hidden reserve', async () => {
    arrange({ reservePricePaise: 120_000n });
    await place(200_000);
    expect(doubles.publishAuctionEvent).toHaveBeenCalledWith(
      expect.objectContaining({ currentBidPaise: 120_000, reserveMet: true }),
    );
  });

  it('PRICE_TOO_HIGH when the bid is above the admin ceiling', async () => {
    arrange();
    prismaMock.appSetting.findUnique.mockResolvedValue({ key: 'auction.maxPricePaise', value: '1000000' });
    const res = await place(1_000_001);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PRICE_TOO_HIGH');
    expect(res.body.error.details).toEqual({ maxPaise: 1_000_000 });
    expect(prismaMock.bid.create).not.toHaveBeenCalled();
  });

  it('accepts a bid above the old int4 limit under the default ceiling', async () => {
    arrange({ startingBidPaise: 5_000_000_000n });
    const res = await place(5_000_000_000);
    expect(res.status).toBe(201);
    expect(res.body.data.bid.amountPaise).toBe(5_000_000_000);
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

describe('POST /auctions/:id/buy-now', () => {
  const buy = async (who = 'bidder1') =>
    request(await getApp())
      .post('/auctions/a1/buy-now')
      .set('Authorization', await bearer('BIDDER', who));

  it('201: inserts the BUY_NOW bid, ends the auction, books the commission, then publishes bid.placed and auction.ended', async () => {
    const base = arrange({ buyNowPricePaise: 900_000n });
    const closed = { ...base, highestBidderId: 'bidder1', bidCount: 1, currentBidPaise: 900_000n };
    prismaMock.auction.findUniqueOrThrow
      .mockResolvedValueOnce(base) // lock + load
      .mockResolvedValueOnce(closed) // inside closeOneTx
      .mockResolvedValueOnce({ ...closed, status: 'ENDED', winnerId: 'bidder1' }); // final read
    prismaMock.auction.updateMany.mockResolvedValue({ count: 1 });

    const res = await buy();
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ auction: { id: 'a1', title: 'Telescope' }, serverTime: NOW.toISOString() });
    expect(prismaMock.bid.create.mock.calls[0][0].data).toMatchObject({ bidderId: 'bidder1', amountPaise: 900_000, kind: 'BUY_NOW' });
    expect(prismaMock.maxBid.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { maxAmountPaise: 900_000 } }));
    expect(prismaMock.auction.update.mock.calls[0][0].data).toMatchObject({
      currentBidPaise: 900_000,
      highestBidderId: 'bidder1',
      bidCount: 1,
      status: 'LIVE',
      endTime: NOW,
    });
    expect(prismaMock.commission.create).toHaveBeenCalledTimes(1);
    const events = doubles.publishAuctionEvent.mock.calls.map((c) => (c as unknown as [Record<string, unknown>])[0]);
    expect(events.map((e) => e.type)).toEqual(['bid.placed', 'auction.ended']);
    expect(events[0]).toMatchObject({ currentBidPaise: 900_000, bidCount: 1, bid: { kind: 'BUY_NOW' } });
    expect(events[1]).toMatchObject({ winnerId: 'bidder1', finalBidPaise: 900_000 });
    expect(doubles.enqueueNotification.mock.calls.map((c) => (c as unknown as [{ type: string }])[0].type)).toEqual([
      'auction-won',
      'auction-sold',
      'commission-due',
    ]);
  });

  it.each([
    ['not offered', { buyNowPricePaise: null }],
    ['a bid already exists', { buyNowPricePaise: 900_000n, bidCount: 1, highestBidderId: 'other', currentBidPaise: 60_000n }],
  ])('409 BUY_NOW_UNAVAILABLE when %s', async (_n, over) => {
    arrange(over);
    const res = await buy();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BUY_NOW_UNAVAILABLE');
    expect(prismaMock.bid.create).not.toHaveBeenCalled();
  });

  it('shares the bid pre-checks (own auction, ended, missing)', async () => {
    arrange({ buyNowPricePaise: 900_000n, sellerId: 'bidder1' });
    expect((await buy()).body.error.code).toBe('OWN_AUCTION');
    arrange({ buyNowPricePaise: 900_000n, endTime: at(-1000) });
    expect((await buy()).body.error.code).toBe('AUCTION_ENDED');
    arrange({ buyNowPricePaise: 900_000n });
    prismaMock.$queryRaw.mockResolvedValue([]);
    expect((await buy()).body.error.code).toBe('AUCTION_NOT_FOUND');
  });
});

describe('POST /auctions (reserve / buy-now rules)', () => {
  const body = {
    title: 'Vintage brass telescope',
    description: 'A fully working brass telescope in excellent condition.',
    category: 'Antiques',
    condition: 'USED',
    images: ['https://cdn.noblebid.test/auctions/a.jpg'],
    startingBidPaise: 50_000,
    startTime: at(HOUR).toISOString(),
    endTime: at(3 * HOUR).toISOString(),
  };
  const create = async (over: Record<string, unknown>) =>
    request(await getApp())
      .post('/auctions')
      .set('Authorization', await bearer('AUCTIONEER', 'seller1'))
      .send({ ...body, ...over });

  beforeEach(() => {
    prismaMock.member.findUnique.mockResolvedValue({ id: 'seller1', isActive: true, unpaidCommissionPaise: 0n });
    prismaMock.appSetting.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
      where.key === 'auction.categories' ? { key: where.key, value: JSON.stringify(['Antiques']) } : null,
    );
  });

  it('400 INVALID_RESERVE when the reserve is below the starting bid', async () => {
    const res = await create({ reservePricePaise: 40_000 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_RESERVE');
    expect(prismaMock.auction.create).not.toHaveBeenCalled();
  });

  it.each([
    ['buy-now equal to the starting bid', { buyNowPricePaise: 50_000 }],
    ['buy-now below the reserve', { reservePricePaise: 90_000, buyNowPricePaise: 80_000 }],
  ])('400 INVALID_BUY_NOW: %s', async (_n, over) => {
    const res = await create(over);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_BUY_NOW');
    expect(prismaMock.auction.create).not.toHaveBeenCalled();
  });
});

describe('GET /auctions/:id/bids and /bids/mine', () => {
  it('lists bids with paging meta, public, label only', async () => {
    prismaMock.auction.findUnique.mockResolvedValue({
      sellerId: 'seller1', status: 'LIVE', deletedAt: null, startTime: at(-HOUR), endTime: at(HOUR),
    });
    prismaMock.bid.findMany.mockResolvedValue([
      { id: 'b2', amountPaise: 70_000, kind: 'MANUAL', createdAt: NOW, bidder: { id: 'u2', name: 'Meera Nair' } },
      { id: 'b1', amountPaise: 60_000, kind: 'AUTO', createdAt: NOW, bidder: { id: 'u1', name: 'Rahul Sharma' } },
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

describe('bid deposits', () => {
  const buy = async () => request(await getApp()).post('/auctions/a1/buy-now').set('Authorization', await bearer('BIDDER', 'bidder1'));

  it('403 DEPOSIT_REQUIRED with the amount when the auction needs a deposit that is not held; no bid is written', async () => {
    arrange({ depositPaise: 1_000_000n });
    const res = await place(2_000_000);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'DEPOSIT_REQUIRED', details: { depositPaise: 1_000_000 } });
    expect(prismaMock.bid.create).not.toHaveBeenCalled();
  });

  it('a PENDING deposit is not enough; a HELD one lets the bid through', async () => {
    arrange({ depositPaise: 1_000_000n });
    prismaMock.auctionDeposit.findUnique.mockResolvedValue({ status: 'PENDING' });
    expect((await place(2_000_000)).body.error.code).toBe('DEPOSIT_REQUIRED');
    prismaMock.auctionDeposit.findUnique.mockResolvedValue({ status: 'HELD' });
    expect((await place(2_000_000)).status).toBe(201);
  });

  it('two active strikes require the strike-based deposit even without an auction deposit', async () => {
    arrange();
    prismaMock.strike.count.mockResolvedValue(2);
    const res = await place(100_000);
    expect(res.body.error).toMatchObject({ code: 'DEPOSIT_REQUIRED', details: { depositPaise: 50_000 } });
  });

  it('Buy It Now needs the deposit too', async () => {
    arrange({ buyNowPricePaise: 900_000n, depositPaise: 1_000_000n });
    const res = await buy();
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('DEPOSIT_REQUIRED');
  });

  it('the shill-bid check runs after the commit and can never fail the bid', async () => {
    arrange();
    prismaMock.session.findMany.mockRejectedValue(new Error('db blip'));
    expect((await place(100_000)).status).toBe(201);
  });
});
