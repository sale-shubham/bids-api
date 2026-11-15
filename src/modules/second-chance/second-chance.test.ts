import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => {
  const d: any = {
    sale: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    secondChanceOffer: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    maxBid: { findMany: vi.fn() },
    bid: { groupBy: vi.fn() },
    auction: { update: vi.fn() },
    member: { update: vi.fn() },
    sellerPayoutAccount: { findUnique: vi.fn() },
    appSetting: { findUnique: vi.fn() },
  };
  d.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(d));
  return d;
});
const enqueue = vi.hoisted(() => vi.fn(async (_m: unknown) => undefined));
vi.mock('@/core/prisma/client', () => ({ prisma: db }));
vi.mock('@/core/logger/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/notify/notify.queue', () => ({ enqueueNotification: enqueue }));

import { OFFER_TTL_MS, offerStatus, pickRunnerUp, toOfferDTO } from './second-chance.rules';
import * as svc from './second-chance.service';
import { toSaleDTO } from '@/modules/sales/sales.service';

const now = new Date('2026-11-15T10:00:00Z');
const H = 3_600_000;
const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => `${e.statusCode}:${e.code}`,
  );
const sent = (type: string) => enqueue.mock.calls.map((c) => c[0] as { type: string; memberId: string; data: Record<string, unknown>; dedupeKey: string }).filter((m) => m.type === type);

describe('pickRunnerUp', () => {
  it('takes the highest max bid', () => {
    expect(
      pickRunnerUp(
        [
          { bidderId: 'a', maxAmountPaise: 500 },
          { bidderId: 'b', maxAmountPaise: 900 },
        ],
        [],
      ),
    ).toEqual({ bidderId: 'b', amountPaise: 900 });
  });
  it("uses the max bid over the bidder's own highest bid row, and the bid row only as a fallback", () => {
    expect(
      pickRunnerUp(
        [{ bidderId: 'a', maxAmountPaise: 700 }],
        [
          { bidderId: 'a', amountPaise: 400 },
          { bidderId: 'c', amountPaise: 650 },
        ],
      ),
    ).toEqual({ bidderId: 'a', amountPaise: 700 });
    expect(pickRunnerUp([], [{ bidderId: 'c', amountPaise: 650 }, { bidderId: 'd', amountPaise: 800 }])).toEqual({ bidderId: 'd', amountPaise: 800 });
  });
  it('null without candidates', () => {
    expect(pickRunnerUp([], [])).toBeNull();
  });
});

describe('offer DTO', () => {
  const offer = {
    id: 'o1',
    auctionId: 'a1',
    amountPaise: 90_000n,
    status: 'PENDING' as const,
    expiresAt: new Date(now.getTime() + H),
    respondedAt: null,
    newSaleId: null,
    createdAt: now,
  };
  it('has the contract fields', () => {
    expect(toOfferDTO(offer, { id: 'a1', title: 'Watch', images: ['c.jpg'] }, now)).toEqual({
      id: 'o1',
      auctionId: 'a1',
      auction: { id: 'a1', title: 'Watch', coverImage: 'c.jpg' },
      amountPaise: 90_000,
      status: 'PENDING',
      expiresAt: offer.expiresAt,
      respondedAt: null,
      newSaleId: null,
      createdAt: now,
    });
  });
  it('a PENDING offer past its expiry reads as EXPIRED before the job runs', () => {
    expect(offerStatus({ status: 'PENDING', expiresAt: new Date(now.getTime() - 1) }, now)).toBe('EXPIRED');
    expect(offerStatus({ status: 'ACCEPTED', expiresAt: new Date(now.getTime() - 1) }, now)).toBe('ACCEPTED');
  });
});

describe('SaleDTO second-chance fields', () => {
  const sale = (over: Record<string, unknown> = {}) =>
    ({
      id: 's1',
      auctionId: 'a1',
      buyerId: 'b1',
      sellerId: 'sel',
      status: 'CANCELLED',
      itemPaise: 100n,
      shippingFeePaise: 0n,
      amountPaise: 100n,
      commissionPaise: 5n,
      payBy: now,
      paidAt: null,
      shippingMethod: null,
      courier: null,
      trackingNo: null,
      shippedAt: null,
      deliveredAt: null,
      releasedAt: null,
      disputedAt: null,
      disputeReason: null,
      refundedAt: null,
      cancelledAt: now,
      createdAt: now,
      auction: { id: 'a1', title: 'Watch', images: [] },
      buyer: { id: 'b1', name: 'B', email: 'b@x', phone: null },
      seller: { id: 'sel', name: 'S', email: 's@x', phone: null },
      secondChanceOffer: null,
      ...over,
    }) as never;
  it('seller view: canOfferSecondChance for a cancelled sale without an offer; the offer once made', () => {
    expect(toSaleDTO(sale(), 'SELLER', now)).toMatchObject({ secondChanceOffer: null, canOfferSecondChance: true });
    const withOffer = toSaleDTO(
      sale({ secondChanceOffer: { id: 'o1', auctionId: 'a1', amountPaise: 90n, status: 'PENDING', expiresAt: new Date(now.getTime() + H), respondedAt: null, newSaleId: null, createdAt: now } }),
      'SELLER',
      now,
    ) as Record<string, any>;
    expect(withOffer.canOfferSecondChance).toBe(false);
    expect(withOffer.secondChanceOffer).toMatchObject({ id: 'o1', amountPaise: 90, status: 'PENDING' });
    expect(toSaleDTO(sale({ status: 'PAID' }), 'SELLER', now)).toMatchObject({ canOfferSecondChance: false });
  });
  it('buyer and admin views do not carry the fields', () => {
    expect(toSaleDTO(sale(), 'BUYER', now)).not.toHaveProperty('canOfferSecondChance');
    expect(toSaleDTO(sale(), 'ADMIN', now)).not.toHaveProperty('secondChanceOffer');
  });
});

const arrangeSale = () =>
  db.sale.findFirst
    .mockResolvedValueOnce({ id: 'sale1', auctionId: 'a1', status: 'CANCELLED', auction: { id: 'a1', title: 'Watch', images: ['c.jpg'] } })
    .mockResolvedValue(null); // no other open sale

describe('createOffer (seller)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
    arrangeSale();
    db.secondChanceOffer.findUnique.mockResolvedValue(null);
    db.sale.findMany.mockResolvedValue([{ buyerId: 'b1' }]);
    db.maxBid.findMany.mockResolvedValue([
      { bidderId: 'r1', maxAmountPaise: 80_000n },
      { bidderId: 'r2', maxAmountPaise: 95_000n },
    ]);
    db.bid.groupBy.mockResolvedValue([{ bidderId: 'r3', _max: { amountPaise: 60_000n } }]);
    db.secondChanceOffer.create.mockImplementation(async ({ data }: any) => ({
      id: 'off1',
      auctionId: data.auctionId,
      amountPaise: BigInt(data.amountPaise),
      status: 'PENDING',
      expiresAt: data.expiresAt,
      respondedAt: null,
      newSaleId: null,
      createdAt: now,
    }));
  });

  it('offers the runner-up at their max for 48 hours and notifies them', async () => {
    const { offer } = await svc.createOffer('sel', 'sale1', now);
    expect(db.secondChanceOffer.create.mock.calls[0][0].data).toEqual({
      saleId: 'sale1',
      auctionId: 'a1',
      bidderId: 'r2',
      amountPaise: 95_000,
      expiresAt: new Date(now.getTime() + OFFER_TTL_MS),
    });
    expect(offer).toMatchObject({ id: 'off1', amountPaise: 95_000, status: 'PENDING', auction: { id: 'a1', title: 'Watch', coverImage: 'c.jpg' } });
    expect(sent('second-chance-offer')[0]).toMatchObject({ memberId: 'r2', data: { offerId: 'off1', amountPaise: 95_000 }, dedupeKey: 'second-chance-offer:off1' });
  });

  it('the runner-up query excludes every buyer of the auction and inactive members', async () => {
    await svc.createOffer('sel', 'sale1', now);
    const where = db.maxBid.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ auctionId: 'a1', bidderId: { notIn: ['b1'] }, bidder: { isActive: true } });
    expect(db.bid.groupBy.mock.calls[0][0].where).toEqual(where);
  });

  it('falls back to the highest bid row when nobody has a MaxBid', async () => {
    db.maxBid.findMany.mockResolvedValue([]);
    await svc.createOffer('sel', 'sale1', now);
    expect(db.secondChanceOffer.create.mock.calls[0][0].data).toMatchObject({ bidderId: 'r3', amountPaise: 60_000 });
  });

  it('409 NO_RUNNER_UP when no other bidder exists', async () => {
    db.maxBid.findMany.mockResolvedValue([]);
    db.bid.groupBy.mockResolvedValue([]);
    expect(await code(svc.createOffer('sel', 'sale1', now))).toBe('409:NO_RUNNER_UP');
    expect(db.secondChanceOffer.create).not.toHaveBeenCalled();
  });

  it('409 OFFER_EXISTS when an offer was already made (also on the unique-violation race)', async () => {
    db.secondChanceOffer.findUnique.mockResolvedValue({ id: 'old' });
    expect(await code(svc.createOffer('sel', 'sale1', now))).toBe('409:OFFER_EXISTS');
    db.secondChanceOffer.findUnique.mockResolvedValue(null);
    arrangeSale();
    db.secondChanceOffer.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
    expect(await code(svc.createOffer('sel', 'sale1', now))).toBe('409:OFFER_EXISTS');
  });

  it('only the seller of a CANCELLED sale may offer', async () => {
    db.sale.findFirst.mockReset();
    db.sale.findFirst.mockResolvedValue(null);
    expect(await code(svc.createOffer('stranger', 'sale1', now))).toBe('404:SALE_NOT_FOUND');
    expect(db.sale.findFirst.mock.calls[0][0].where).toEqual({ id: 'sale1', sellerId: 'stranger' });
    db.sale.findFirst.mockReset();
    db.sale.findFirst.mockResolvedValue({ id: 'sale1', auctionId: 'a1', status: 'PAID', auction: {} });
    expect(await code(svc.createOffer('sel', 'sale1', now))).toBe('409:SALE_INVALID_STATE');
  });
});

describe('accept / decline / expire (bidder)', () => {
  const offer = (over: Record<string, unknown> = {}) => ({
    id: 'off1',
    saleId: 'sale1',
    auctionId: 'a1',
    bidderId: 'r2',
    amountPaise: 95_000n,
    status: 'PENDING',
    expiresAt: new Date(now.getTime() + H),
    respondedAt: null,
    newSaleId: null,
    createdAt: now,
    auction: { id: 'a1', title: 'Watch', images: [], sellerId: 'sel' },
    ...over,
  });
  beforeEach(() => {
    vi.resetAllMocks();
    db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
    db.secondChanceOffer.findFirst.mockResolvedValue(offer());
    db.sellerPayoutAccount.findUnique.mockResolvedValue({ status: 'ACTIVE' });
    db.appSetting.findUnique.mockResolvedValue({ value: '700' });
    db.secondChanceOffer.updateMany.mockResolvedValue({ count: 1 });
    db.sale.findUnique.mockResolvedValue({ buyerId: 'b1' });
    db.sale.create.mockResolvedValue({ id: 'sale2' });
  });

  it('accept creates a new AWAITING_PAYMENT sale at the offer amount, makes the bidder the winner, notifies the seller', async () => {
    const out = await svc.acceptOffer('r2', 'off1', now);
    expect(db.secondChanceOffer.updateMany).toHaveBeenCalledWith({
      where: { id: 'off1', status: 'PENDING', expiresAt: { gt: now } },
      data: { status: 'ACCEPTED', respondedAt: now },
    });
    expect(db.sale.create.mock.calls[0][0].data).toEqual({
      auctionId: 'a1',
      buyerId: 'r2',
      sellerId: 'sel',
      itemPaise: 95_000,
      shippingFeePaise: 0,
      amountPaise: 95_000,
      commissionPaise: 6_650, // 7% (the current rate) of 95,000
      rateBps: 700,
      payBy: new Date(now.getTime() + 3 * 24 * H),
    });
    expect(db.secondChanceOffer.update).toHaveBeenCalledWith({ where: { id: 'off1' }, data: { newSaleId: 'sale2' } });
    expect(db.auction.update).toHaveBeenCalledWith({ where: { id: 'a1' }, data: { winnerId: 'r2' } });
    expect(out.saleId).toBe('sale2');
    expect(sent('second-chance-accepted')[0]).toMatchObject({ memberId: 'sel', data: { saleId: 'sale2' }, dedupeKey: 'second-chance-accepted:off1' });
  });

  it('accept is refused when expired, already answered, or the seller cannot be paid', async () => {
    db.secondChanceOffer.findFirst.mockResolvedValue(offer({ expiresAt: new Date(now.getTime() - 1) }));
    expect(await code(svc.acceptOffer('r2', 'off1', now))).toBe('409:OFFER_EXPIRED');
    db.secondChanceOffer.findFirst.mockResolvedValue(offer({ status: 'DECLINED' }));
    expect(await code(svc.acceptOffer('r2', 'off1', now))).toBe('409:OFFER_NOT_PENDING');
    db.secondChanceOffer.findFirst.mockResolvedValue(offer());
    db.sellerPayoutAccount.findUnique.mockResolvedValue({ status: 'PENDING' });
    expect(await code(svc.acceptOffer('r2', 'off1', now))).toBe('409:PAYOUT_ACCOUNT_INACTIVE');
    db.sellerPayoutAccount.findUnique.mockResolvedValue(null);
    expect(await code(svc.acceptOffer('r2', 'off1', now))).toBe('409:PAYOUT_ACCOUNT_INACTIVE');
    expect(db.sale.create).not.toHaveBeenCalled();
  });

  it('accept: a concurrent answer (guard matches nothing) creates no sale', async () => {
    db.secondChanceOffer.updateMany.mockResolvedValue({ count: 0 });
    expect(await code(svc.acceptOffer('r2', 'off1', now))).toBe('409:OFFER_NOT_PENDING');
    expect(db.sale.create).not.toHaveBeenCalled();
  });

  it("someone else's offer is a 404", async () => {
    db.secondChanceOffer.findFirst.mockResolvedValue(null);
    expect(await code(svc.acceptOffer('x', 'off1', now))).toBe('404:OFFER_NOT_FOUND');
    expect(db.secondChanceOffer.findFirst.mock.calls[0][0].where).toEqual({ id: 'off1', bidderId: 'x' });
  });

  it('decline marks DECLINED and notifies the seller; a second decline is 409', async () => {
    await svc.declineOffer('r2', 'off1', now);
    expect(db.secondChanceOffer.updateMany).toHaveBeenCalledWith({ where: { id: 'off1', status: 'PENDING' }, data: { status: 'DECLINED', respondedAt: now } });
    expect(sent('second-chance-declined')[0]).toMatchObject({ memberId: 'sel', dedupeKey: 'second-chance-declined:off1' });
    db.secondChanceOffer.updateMany.mockResolvedValue({ count: 0 });
    expect(await code(svc.declineOffer('r2', 'off1', now))).toBe('409:OFFER_NOT_PENDING');
  });

  it('mine lists PENDING offers first', async () => {
    db.secondChanceOffer.findMany.mockResolvedValue([
      offer({ id: 'old', status: 'DECLINED', createdAt: new Date(now.getTime() + 5) }),
      offer({ id: 'new' }),
    ]);
    const { items } = await svc.listMine('r2', now);
    expect(items.map((i) => i.id)).toEqual(['new', 'old']);
  });

  it('expireOffers moves PENDING offers past expiresAt to EXPIRED', async () => {
    db.secondChanceOffer.updateMany.mockResolvedValue({ count: 3 });
    expect(await svc.expireOffers(now)).toBe(3);
    expect(db.secondChanceOffer.updateMany).toHaveBeenCalledWith({ where: { status: 'PENDING', expiresAt: { lte: now } }, data: { status: 'EXPIRED' } });
  });
});
