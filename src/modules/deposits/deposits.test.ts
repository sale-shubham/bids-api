import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => {
  const d: any = {
    auction: { findUnique: vi.fn() },
    auctionDeposit: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn(), updateMany: vi.fn() },
    strike: { count: vi.fn() },
    member: { findUnique: vi.fn() },
    sale: { findFirst: vi.fn() },
    paymentOrder: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    appSetting: { findUnique: vi.fn() },
  };
  d.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(d));
  return d;
});
const provider = vi.hoisted(() => ({ publicKey: 'rzp_key', createOrder: vi.fn(), refundPayment: vi.fn() }));
const enqueue = vi.hoisted(() => vi.fn(async (_m: unknown) => undefined));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock('@/core/prisma/client', () => ({ prisma: db }));
vi.mock('@/core/logger/logger', () => ({ logger: log }));
vi.mock('@/providers/payment', () => ({ paymentProvider: provider }));
vi.mock('@/modules/notify/notify.queue', () => ({ enqueueNotification: enqueue }));

import {
  MIN_STRIKE_DEPOSIT_PAISE,
  computeDepositPaise,
  parseDepositConfig,
  releaseDecision,
  requiredDepositPaise,
} from './deposits.rules';
import * as svc from './deposits.service';
import { runDepositRelease } from './deposits.jobs';

const now = new Date('2026-11-15T10:00:00Z');
const H = 3_600_000;
const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => `${e.statusCode}:${e.code}`,
  );
const sentTypes = () => enqueue.mock.calls.map((c) => (c[0] as { type: string }).type);

describe('computeDepositPaise', () => {
  const cfg = { thresholdPaise: 10_000_000, rateBps: 1000 };
  it('is rate x starting bid from the threshold up, rounded to the paisa', () => {
    expect(computeDepositPaise(10_000_000, cfg)).toBe(1_000_000);
    expect(computeDepositPaise(25_000_001, cfg)).toBe(2_500_000);
    expect(computeDepositPaise(10_000_005, { thresholdPaise: 10_000_000, rateBps: 333 })).toBe(333_000);
  });
  it('is null below the threshold, and always when the threshold is 0 (feature off)', () => {
    expect(computeDepositPaise(9_999_999, cfg)).toBeNull();
    expect(computeDepositPaise(50_000_000_000, { ...cfg, thresholdPaise: 0 })).toBeNull();
  });
  it('parseDepositConfig: defaults, 0 = off, out-of-range falls back', () => {
    expect(parseDepositConfig(null, null)).toEqual({ thresholdPaise: 10_000_000, rateBps: 1000 });
    expect(parseDepositConfig('0', '2500')).toEqual({ thresholdPaise: 0, rateBps: 2500 });
    expect(parseDepositConfig('-5', '99')).toEqual({ thresholdPaise: 10_000_000, rateBps: 1000 });
    expect(parseDepositConfig('abc', '5001')).toEqual({ thresholdPaise: 10_000_000, rateBps: 1000 });
  });
});

describe('requiredDepositPaise', () => {
  const base = { auctionDepositPaise: null, activeStrikes: 0, startingBidPaise: 100_000, currentBidPaise: 0, rateBps: 1000 };
  it("is the auction's own deposit when set (strikes do not stack)", () => {
    expect(requiredDepositPaise({ ...base, auctionDepositPaise: 1_000_000, activeStrikes: 3 })).toBe(1_000_000);
  });
  it('is 0 without an auction deposit and fewer than 2 strikes', () => {
    expect(requiredDepositPaise(base)).toBe(0);
    expect(requiredDepositPaise({ ...base, activeStrikes: 1 })).toBe(0);
    expect(requiredDepositPaise({ ...base, auctionDepositPaise: 0 })).toBe(0);
  });
  it('2+ strikes: rate x max(starting, current bid) with a floor of Rs 500', () => {
    expect(requiredDepositPaise({ ...base, activeStrikes: 2, startingBidPaise: 100_000 })).toBe(MIN_STRIKE_DEPOSIT_PAISE);
    expect(requiredDepositPaise({ ...base, activeStrikes: 2, startingBidPaise: 600_000 })).toBe(60_000);
    expect(requiredDepositPaise({ ...base, activeStrikes: 3, startingBidPaise: 600_000, currentBidPaise: 2_000_000 })).toBe(200_000);
  });
});

describe('releaseDecision', () => {
  const a = { auctionStatus: 'ENDED' as const, auctionDeleted: false, winnerId: 'w', memberId: 'm', saleStatus: null as string | null };
  it('waits while the auction is open', () => {
    expect(releaseDecision({ ...a, auctionStatus: 'LIVE' })).toBe('WAIT');
    expect(releaseDecision({ ...a, auctionStatus: 'SCHEDULED' })).toBe('WAIT');
  });
  it('refunds a cancelled / deleted auction', () => {
    expect(releaseDecision({ ...a, auctionStatus: 'CANCELLED' })).toBe('REFUND');
    expect(releaseDecision({ ...a, auctionStatus: 'LIVE', auctionDeleted: true })).toBe('REFUND');
  });
  it('refunds a loser, and everyone when nobody won', () => {
    expect(releaseDecision(a)).toBe('REFUND');
    expect(releaseDecision({ ...a, winnerId: null })).toBe('REFUND');
  });
  it('winner: PAID or later refunds, CANCELLED forfeits, AWAITING_PAYMENT waits, no sale (legacy) refunds', () => {
    const w = { ...a, winnerId: 'm' };
    for (const s of ['PAID', 'SHIPPED', 'DELIVERED', 'RELEASED', 'DISPUTED', 'REFUNDED']) {
      expect(releaseDecision({ ...w, saleStatus: s })).toBe('REFUND');
    }
    expect(releaseDecision({ ...w, saleStatus: 'CANCELLED' })).toBe('FORFEIT');
    expect(releaseDecision({ ...w, saleStatus: 'AWAITING_PAYMENT' })).toBe('WAIT');
    expect(releaseDecision({ ...w, saleStatus: null })).toBe('REFUND');
  });
});

describe('deposit checkout', () => {
  const auction = (over: Record<string, unknown> = {}) => ({
    id: 'a1',
    title: 'Vintage Watch',
    status: 'LIVE',
    deletedAt: null,
    startTime: new Date(now.getTime() - H),
    endTime: new Date(now.getTime() + H),
    sellerId: 's1',
    startingBidPaise: 20_000_000n,
    currentBidPaise: 0n,
    depositPaise: 2_000_000n,
    ...over,
  });

  beforeEach(() => {
    vi.resetAllMocks();
    db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
    db.auction.findUnique.mockResolvedValue(auction());
    db.appSetting.findUnique.mockResolvedValue(null);
    db.auctionDeposit.findUnique.mockResolvedValue(null);
    db.auctionDeposit.upsert.mockResolvedValue({ id: 'dep1' });
    db.strike.count.mockResolvedValue(0);
    db.member.findUnique.mockResolvedValue({ name: 'Asha', email: 'a@x.test', phone: '9000000000' });
    db.paymentOrder.findFirst.mockResolvedValue(null);
    provider.createOrder.mockResolvedValue({ gatewayOrderId: 'order_1', keyId: 'rzp_key' });
  });

  it('creates the PENDING deposit and a DEPOSIT order without transfers, same payload shape as the sale checkout', async () => {
    const out = await svc.checkout('b1', 'a1', now);
    expect(out).toEqual({
      orderId: 'order_1',
      amountPaise: 2_000_000,
      currency: 'INR',
      keyId: 'rzp_key',
      description: 'Refundable deposit for "Vintage Watch"',
      prefill: { name: 'Asha', email: 'a@x.test', contact: '9000000000' },
    });
    expect(db.auctionDeposit.upsert).toHaveBeenCalledWith({
      where: { auctionId_memberId: { auctionId: 'a1', memberId: 'b1' } },
      create: { auctionId: 'a1', memberId: 'b1', amountPaise: 2_000_000, status: 'PENDING' },
      update: { amountPaise: 2_000_000, status: 'PENDING' },
      select: { id: true },
    });
    expect(provider.createOrder.mock.calls[0][0]).not.toHaveProperty('transfers');
    expect(db.paymentOrder.create.mock.calls[0][0].data).toMatchObject({
      memberId: 'b1',
      gatewayOrderId: 'order_1',
      referenceType: 'DEPOSIT',
      referenceId: 'dep1',
      idempotencyKey: 'deposit:dep1:order_1',
    });
  });

  it('reuses a recent CREATED order for the same amount', async () => {
    db.paymentOrder.findFirst.mockResolvedValue({ gatewayOrderId: 'order_old' });
    const out = await svc.checkout('b1', 'a1', now);
    expect(out.orderId).toBe('order_old');
    expect(provider.createOrder).not.toHaveBeenCalled();
    expect(db.paymentOrder.create).not.toHaveBeenCalled();
  });

  it('409 DEPOSIT_ALREADY_HELD when a HELD deposit exists', async () => {
    db.auctionDeposit.findUnique.mockResolvedValue({ status: 'HELD' });
    expect(await code(svc.checkout('b1', 'a1', now))).toBe('409:DEPOSIT_ALREADY_HELD');
    expect(provider.createOrder).not.toHaveBeenCalled();
  });

  it('409 DEPOSIT_NOT_REQUIRED when nothing is required', async () => {
    db.auction.findUnique.mockResolvedValue(auction({ depositPaise: null }));
    expect(await code(svc.checkout('b1', 'a1', now))).toBe('409:DEPOSIT_NOT_REQUIRED');
  });

  it('a bidder with 2 strikes owes the strike-based deposit even without an auction deposit', async () => {
    db.auction.findUnique.mockResolvedValue(auction({ depositPaise: null, startingBidPaise: 600_000n }));
    db.strike.count.mockResolvedValue(2);
    expect((await svc.checkout('b1', 'a1', now)).amountPaise).toBe(60_000);
  });

  it('closed / cancelled / missing auctions and the seller are refused', async () => {
    db.auction.findUnique.mockResolvedValue(auction({ endTime: new Date(now.getTime() - 1) }));
    expect(await code(svc.checkout('b1', 'a1', now))).toBe('409:AUCTION_ENDED');
    db.auction.findUnique.mockResolvedValue(auction({ status: 'ENDED' }));
    expect(await code(svc.checkout('b1', 'a1', now))).toBe('409:AUCTION_ENDED');
    db.auction.findUnique.mockResolvedValue(auction({ status: 'CANCELLED' }));
    expect(await code(svc.checkout('b1', 'a1', now))).toBe('404:AUCTION_NOT_FOUND');
    db.auction.findUnique.mockResolvedValue(null);
    expect(await code(svc.checkout('b1', 'a1', now))).toBe('404:AUCTION_NOT_FOUND');
    db.auction.findUnique.mockResolvedValue(auction());
    expect(await code(svc.checkout('s1', 'a1', now))).toBe('403:OWN_AUCTION');
  });

  it('a scheduled (not yet started) auction is open for deposits', async () => {
    db.auction.findUnique.mockResolvedValue(auction({ status: 'SCHEDULED', startTime: new Date(now.getTime() + H), endTime: new Date(now.getTime() + 5 * H) }));
    expect(await code(svc.checkout('b1', 'a1', now))).toBe('ok');
  });
});

describe('markDepositHeld', () => {
  const order = { id: 'o1', referenceType: 'DEPOSIT', referenceId: 'dep1' };
  beforeEach(() => {
    vi.resetAllMocks();
    db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
    db.paymentOrder.findUnique.mockResolvedValue(order);
    db.auctionDeposit.findUnique.mockResolvedValue({ id: 'dep1', auctionId: 'a1', memberId: 'b1', amountPaise: 2_000_000n });
    db.auctionDeposit.updateMany.mockResolvedValue({ count: 1 });
    db.paymentOrder.updateMany.mockResolvedValue({ count: 1 });
  });

  it('moves PENDING -> HELD with the payment id and heldAt, and notifies once', async () => {
    const res = await svc.markDepositHeld({ paymentOrderId: 'o1', gatewayPaymentId: 'pay_1' }, now);
    expect(res).toEqual({ applied: true, depositId: 'dep1' });
    expect(db.auctionDeposit.updateMany).toHaveBeenCalledWith({
      where: { id: 'dep1', status: 'PENDING' },
      data: { status: 'HELD', heldAt: now, paymentOrderId: 'o1', gatewayPaymentId: 'pay_1' },
    });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ type: 'deposit-held', memberId: 'b1', dedupeKey: 'deposit-held:dep1' }));
  });

  it('is idempotent: a second delivery changes nothing and sends nothing', async () => {
    db.auctionDeposit.updateMany.mockResolvedValue({ count: 0 });
    const res = await svc.markDepositHeld({ paymentOrderId: 'o1', gatewayPaymentId: 'pay_1' }, now);
    expect(res).toEqual({ applied: false, depositId: 'dep1' });
    expect(enqueue).not.toHaveBeenCalled();
    // the gateway took the money either way
    expect(db.paymentOrder.updateMany).toHaveBeenCalled();
  });

  it('ignores an order that is not a DEPOSIT order', async () => {
    db.paymentOrder.findUnique.mockResolvedValue({ id: 'o1', referenceType: 'SALE', referenceId: 'x' });
    expect(await svc.markDepositHeld({ paymentOrderId: 'o1' }, now)).toEqual({ applied: false, depositId: null });
    expect(db.auctionDeposit.updateMany).not.toHaveBeenCalled();
  });
});

describe('runDepositRelease', () => {
  const held = (over: Record<string, unknown> = {}, auction: Record<string, unknown> = {}) => ({
    id: 'dep1',
    auctionId: 'a1',
    memberId: 'm1',
    amountPaise: 2_000_000n,
    gatewayPaymentId: 'pay_1',
    auction: { status: 'ENDED', deletedAt: null, winnerId: 'other', ...auction },
    ...over,
  });
  const run = (...rows: unknown[]) => {
    db.auctionDeposit.findMany.mockResolvedValue(rows);
    return runDepositRelease(now);
  };

  beforeEach(() => {
    vi.resetAllMocks();
    db.auctionDeposit.updateMany.mockResolvedValue({ count: 1 });
    db.sale.findFirst.mockResolvedValue(null);
    provider.refundPayment.mockResolvedValue({ id: 'rfnd_1' });
  });

  it('refunds a loser: gateway refund (no reverse), REFUNDED + refundId + refundedAt, notification', async () => {
    expect(await run(held())).toEqual({ refunded: 1, forfeited: 0 });
    expect(provider.refundPayment).toHaveBeenCalledWith('pay_1', { amountPaise: 2_000_000, reverseAll: false });
    expect(db.auctionDeposit.updateMany).toHaveBeenCalledWith({
      where: { id: 'dep1', status: 'HELD' },
      data: { status: 'REFUNDED', refundId: 'rfnd_1', refundedAt: now },
    });
    expect(sentTypes()).toEqual(['deposit-refunded']);
  });

  it('refunds when nobody won', async () => {
    expect((await run(held({}, { winnerId: null }))).refunded).toBe(1);
  });

  it('refunds a winner whose sale is PAID or later', async () => {
    db.sale.findFirst.mockResolvedValue({ status: 'PAID' });
    expect((await run(held({}, { winnerId: 'm1' }))).refunded).toBe(1);
    expect(db.sale.findFirst).toHaveBeenCalledWith({
      where: { auctionId: 'a1', buyerId: 'm1' },
      orderBy: { createdAt: 'desc' },
      select: { status: true },
    });
  });

  it('forfeits a winner whose sale was cancelled for non-payment (no refund call)', async () => {
    db.sale.findFirst.mockResolvedValue({ status: 'CANCELLED' });
    expect(await run(held({}, { winnerId: 'm1' }))).toEqual({ refunded: 0, forfeited: 1 });
    expect(provider.refundPayment).not.toHaveBeenCalled();
    expect(db.auctionDeposit.updateMany).toHaveBeenCalledWith({
      where: { id: 'dep1', status: 'HELD' },
      data: { status: 'FORFEITED', forfeitedAt: now },
    });
    expect(sentTypes()).toEqual(['deposit-forfeited']);
  });

  it('leaves a winner with an unpaid, still open sale alone', async () => {
    db.sale.findFirst.mockResolvedValue({ status: 'AWAITING_PAYMENT' });
    expect(await run(held({}, { winnerId: 'm1' }))).toEqual({ refunded: 0, forfeited: 0 });
    expect(db.auctionDeposit.updateMany).not.toHaveBeenCalled();
  });

  it('legacy mode: a winner without any Sale is refunded', async () => {
    db.sale.findFirst.mockResolvedValue(null);
    expect((await run(held({}, { winnerId: 'm1' }))).refunded).toBe(1);
  });

  it('refunds when the auction was cancelled', async () => {
    expect((await run(held({}, { status: 'CANCELLED', winnerId: null }))).refunded).toBe(1);
    expect((await run(held({}, { status: 'LIVE', deletedAt: now }))).refunded).toBe(1);
  });

  it('a refund failure leaves the deposit HELD, logs it, and the batch continues', async () => {
    provider.refundPayment.mockRejectedValueOnce(new Error('gateway down')).mockResolvedValueOnce({ id: 'rfnd_2' });
    const counts = await run(held({ id: 'dep1' }), held({ id: 'dep2', memberId: 'm2' }));
    expect(counts).toEqual({ refunded: 1, forfeited: 0 });
    expect(db.auctionDeposit.updateMany).toHaveBeenCalledTimes(1);
    expect(db.auctionDeposit.updateMany.mock.calls[0][0].where.id).toBe('dep2');
    expect(log.error).toHaveBeenCalled();
  });

  it('is idempotent: a deposit that already moved is not counted or notified', async () => {
    db.auctionDeposit.updateMany.mockResolvedValue({ count: 0 });
    expect(await run(held())).toEqual({ refunded: 0, forfeited: 0 });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('a held deposit without a payment id cannot be refunded: logged and skipped', async () => {
    expect((await run(held({ gatewayPaymentId: null }))).refunded).toBe(0);
    expect(provider.refundPayment).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
  });

  it('is batch-limited and only looks at HELD deposits of finished auctions', async () => {
    await run();
    const arg = db.auctionDeposit.findMany.mock.calls[0][0];
    expect(arg.take).toBe(100);
    expect(arg.where.status).toBe('HELD');
  });
});
