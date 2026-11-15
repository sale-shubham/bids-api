import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  sale: { findFirst: vi.fn(), updateMany: vi.fn() },
  sellerPayoutAccount: { findUnique: vi.fn() },
  member: { findUnique: vi.fn() },
  paymentOrder: { findFirst: vi.fn(), create: vi.fn() },
}));
const provider = vi.hoisted(() => ({ publicKey: 'rzp_key', createOrder: vi.fn() }));

vi.mock('@/core/prisma/client', () => ({ prisma: db }));
vi.mock('@/core/logger/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/providers/payment', () => ({ paymentProvider: provider }));
vi.mock('@/modules/notify/notify.queue', () => ({ enqueueNotification: vi.fn() }));

import * as svc from './sales.service';
import { resolveDelivery } from './sales.rules';
import { checkoutSchema } from './sales.validation';

const now = new Date('2026-11-15T10:00:00Z');
const DAY = 86_400_000;
const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => `${e.statusCode}:${e.code}`,
  );

const both = { pickup: true, pickupCity: 'Pune', courier: true, shippingFeePaise: 25_000 };
const sale = (shippingOptions: unknown, over: Record<string, unknown> = {}) => ({
  id: 'sale1',
  status: 'AWAITING_PAYMENT',
  payBy: new Date(now.getTime() + DAY),
  sellerId: 's1',
  itemPaise: 100_000n,
  shippingFeePaise: 0n,
  deliveryChoice: null,
  amountPaise: 100_000n,
  commissionPaise: 5_000n,
  auction: { title: 'Watch', shippingOptions },
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  db.sale.updateMany.mockResolvedValue({ count: 1 });
  db.sellerPayoutAccount.findUnique.mockResolvedValue({ status: 'ACTIVE', razorpayAccountId: 'acc_1' });
  db.member.findUnique.mockResolvedValue({ name: 'Buyer', email: 'b@x.test', phone: '9000000000' });
  db.paymentOrder.findFirst.mockResolvedValue(null);
  provider.createOrder.mockResolvedValue({ gatewayOrderId: 'order_1', keyId: 'rzp_key' });
});

describe('resolveDelivery', () => {
  it('legacy auctions (no options) are left alone', () => expect(resolveDelivery(null, undefined)).toEqual({ kind: 'legacy' }));
  it('both options need a choice', () => {
    const o = { pickup: true, courier: true, shippingFeePaise: 500 };
    expect(resolveDelivery(o, undefined)).toEqual({ kind: 'required' });
    expect(resolveDelivery(o, 'COURIER')).toEqual({ kind: 'chosen', choice: 'COURIER', shippingFeePaise: 500 });
    expect(resolveDelivery(o, 'PICKUP')).toEqual({ kind: 'chosen', choice: 'PICKUP', shippingFeePaise: 0 });
  });
  it('a single option is used whatever was sent; courier fee defaults to 0', () => {
    expect(resolveDelivery({ pickup: true, courier: false, shippingFeePaise: null }, 'COURIER')).toEqual({ kind: 'chosen', choice: 'PICKUP', shippingFeePaise: 0 });
    expect(resolveDelivery({ pickup: false, courier: true, shippingFeePaise: null }, undefined)).toEqual({ kind: 'chosen', choice: 'COURIER', shippingFeePaise: 0 });
  });
});

describe('checkoutSchema', () => {
  it('delivery is optional and COURIER | PICKUP', () => {
    expect(checkoutSchema.validate({}).error).toBeUndefined();
    expect(checkoutSchema.validate({ delivery: 'PICKUP' }).error).toBeUndefined();
    expect(checkoutSchema.validate({ delivery: 'DRONE' }).error).toBeDefined();
  });
});

describe('checkout with a delivery choice', () => {
  it('both offered and no choice -> 400 DELIVERY_CHOICE_REQUIRED, nothing written', async () => {
    db.sale.findFirst.mockResolvedValue(sale(both));
    expect(await code(svc.checkout('b1', 'sale1', now))).toBe('400:DELIVERY_CHOICE_REQUIRED');
    expect(db.sale.updateMany).not.toHaveBeenCalled();
    expect(provider.createOrder).not.toHaveBeenCalled();
  });

  it('courier: fee and amount updated on the sale, order and seller transfer follow (commission stays on the item)', async () => {
    db.sale.findFirst.mockResolvedValue(sale(both));
    const r = await svc.checkout('b1', 'sale1', now, 'COURIER');
    expect(db.sale.updateMany).toHaveBeenCalledWith({
      where: { id: 'sale1', status: 'AWAITING_PAYMENT' },
      data: { deliveryChoice: 'COURIER', shippingFeePaise: 25_000, amountPaise: 125_000 },
    });
    expect(r.amountPaise).toBe(125_000);
    const arg = provider.createOrder.mock.calls[0][0];
    expect(arg.amountPaise).toBe(125_000);
    expect(arg.transfers[0].amountPaise).toBe(120_000);
    expect(db.paymentOrder.create.mock.calls[0][0].data.amountPaise).toBe(125_000);
  });

  it('pickup: no fee, amount is the item price', async () => {
    db.sale.findFirst.mockResolvedValue(sale(both, { shippingFeePaise: 25_000n, amountPaise: 125_000n, deliveryChoice: 'COURIER' }));
    const r = await svc.checkout('b1', 'sale1', now, 'PICKUP');
    expect(db.sale.updateMany.mock.calls[0][0].data).toEqual({ deliveryChoice: 'PICKUP', shippingFeePaise: 0, amountPaise: 100_000 });
    expect(r.amountPaise).toBe(100_000);
    expect(provider.createOrder.mock.calls[0][0].transfers[0].amountPaise).toBe(95_000);
  });

  it('a single offered option is used without a body (courier only)', async () => {
    db.sale.findFirst.mockResolvedValue(sale({ pickup: false, courier: true, shippingFeePaise: 10_000 }));
    const r = await svc.checkout('b1', 'sale1', now);
    expect(r.amountPaise).toBe(110_000);
    expect(db.sale.updateMany.mock.calls[0][0].data).toMatchObject({ deliveryChoice: 'COURIER', shippingFeePaise: 10_000 });
  });

  it('courier with no fee set ships for 0', async () => {
    db.sale.findFirst.mockResolvedValue(sale({ pickup: false, courier: true }));
    const r = await svc.checkout('b1', 'sale1', now);
    expect(r.amountPaise).toBe(100_000);
  });

  it('legacy auction (no shippingOptions): sale untouched, fee 0, as before', async () => {
    db.sale.findFirst.mockResolvedValue(sale(null));
    const r = await svc.checkout('b1', 'sale1', now, 'COURIER');
    expect(db.sale.updateMany).not.toHaveBeenCalled();
    expect(r.amountPaise).toBe(100_000);
  });

  it('unchanged choice does not rewrite the sale', async () => {
    db.sale.findFirst.mockResolvedValue(sale(both, { shippingFeePaise: 25_000n, amountPaise: 125_000n, deliveryChoice: 'COURIER' }));
    await svc.checkout('b1', 'sale1', now, 'COURIER');
    expect(db.sale.updateMany).not.toHaveBeenCalled();
  });

  it('never reuses an order whose amount differs: the lookup uses the new amount', async () => {
    db.sale.findFirst.mockResolvedValue(sale(both));
    await svc.checkout('b1', 'sale1', now, 'COURIER');
    expect(db.paymentOrder.findFirst.mock.calls[0][0].where).toMatchObject({ amountPaise: 125_000, status: 'CREATED' });
  });

  it('the sale moving out of AWAITING_PAYMENT between read and write -> 409 SALE_NOT_PAYABLE, no order', async () => {
    db.sale.findFirst.mockResolvedValue(sale(both));
    db.sale.updateMany.mockResolvedValue({ count: 0 });
    expect(await code(svc.checkout('b1', 'sale1', now, 'COURIER'))).toBe('409:SALE_NOT_PAYABLE');
    expect(provider.createOrder).not.toHaveBeenCalled();
  });
});

describe('SaleDTO', () => {
  const person = (id: string) => ({ id, name: id, email: `${id}@x.test`, phone: null });
  const row = (shippingOptions: unknown, deliveryChoice: string | null) =>
    ({
      id: 'sale1', auctionId: 'a1', buyerId: 'b1', sellerId: 's1', status: 'AWAITING_PAYMENT',
      itemPaise: 100_000n, shippingFeePaise: 0n, amountPaise: 100_000n, commissionPaise: 5_000n,
      deliveryChoice,
      payBy: now, paidAt: null, shippingMethod: null, courier: null, trackingNo: null, shippedAt: null, deliveredAt: null,
      releasedAt: null, disputedAt: null, disputeReason: null, refundedAt: null, cancelledAt: null, createdAt: now,
      auction: { id: 'a1', title: 'Watch', images: [], shippingOptions },
      buyer: person('b1'), seller: person('s1'),
    }) as never;
  it('carries deliveryChoice and the auction shippingOptions', () => {
    expect(svc.toSaleDTO(row(both, 'COURIER'), 'BUYER')).toMatchObject({
      deliveryChoice: 'COURIER',
      shippingOptions: { pickup: true, pickupCity: 'Pune', courier: true, shippingFeePaise: 25_000, shipsWithinDays: null },
    });
    expect(svc.toSaleDTO(row(null, null), 'BUYER')).toMatchObject({ deliveryChoice: null, shippingOptions: null });
  });
});
