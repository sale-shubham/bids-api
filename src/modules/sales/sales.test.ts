import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => {
  const d: any = {
    sale: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
    sellerPayoutAccount: { findUnique: vi.fn() },
    member: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    session: { deleteMany: vi.fn() },
    strike: { create: vi.fn(), count: vi.fn() },
    auctionDeposit: { findMany: vi.fn(), updateMany: vi.fn() },
    secondChanceOffer: { updateMany: vi.fn() },
    paymentOrder: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    commission: { create: vi.fn(), updateMany: vi.fn() },
  };
  d.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(d));
  return d;
});
const provider = vi.hoisted(() => ({
  publicKey: 'rzp_key',
  createOrder: vi.fn(),
  fetchPaymentTransfers: vi.fn(),
  releaseTransfer: vi.fn(),
  refundPayment: vi.fn(),
}));
const enqueue = vi.hoisted(() => vi.fn(async (_m: unknown) => undefined));

vi.mock('@/core/prisma/client', () => ({ prisma: db }));
vi.mock('@/core/logger/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/providers/payment', () => ({ paymentProvider: provider }));
vi.mock('@/modules/notify/notify.queue', () => ({ enqueueNotification: enqueue }));
const referral = vi.hoisted(() => ({ qualifyReferralBestEffort: vi.fn(async (_ids: string[]) => undefined) }));
vi.mock('@/modules/referrals/referrals.service', () => referral);
const disconnect = vi.hoisted(() => vi.fn(async (_id: string) => undefined));
vi.mock('@/modules/ws/ws.service', () => ({ disconnectMemberConnections: disconnect }));

import * as svc from './sales.service';
import { runSalesMaintenance } from './sales.jobs';
import { adminRefund, adminRelease } from '@/modules/admin/sales/admin-sales.service';
import { disputeSchema, mineQuerySchema, shipSchema } from './sales.validation';

const now = new Date('2026-11-15T10:00:00Z');
const DAY = 86_400_000;
const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => `${e.statusCode}:${e.code}`,
  );
const types = () => enqueue.mock.calls.map((c) => (c[0] as { type: string }).type);

const facts = {
  id: 'sale1',
  auctionId: 'a1',
  buyerId: 'b1',
  sellerId: 's1',
  status: 'AWAITING_PAYMENT',
  amountPaise: 100_000n,
  commissionPaise: 5_000n,
  transferId: null as string | null,
  gatewayPaymentId: 'pay_1' as string | null,
};
const person = (id: string) => ({ id, name: `N-${id}`, email: `${id}@x.test`, phone: '9000000000' });
const row = (over: Record<string, unknown> = {}) => ({
  id: 'sale1',
  auctionId: 'a1',
  buyerId: 'b1',
  sellerId: 's1',
  status: 'PAID',
  itemPaise: 100_000n,
  shippingFeePaise: 0n,
  amountPaise: 100_000n,
  commissionPaise: 5_000n,
  payBy: new Date(now.getTime() + DAY),
  paidAt: now,
  shippingMethod: null,
  courier: null,
  trackingNo: null,
  shippedAt: null,
  deliveredAt: null,
  releasedAt: null,
  disputedAt: null,
  disputeReason: null,
  refundedAt: null,
  cancelledAt: null,
  createdAt: now,
  auction: { id: 'a1', title: 'Watch', images: ['c.jpg'] },
  buyer: person('b1'),
  seller: person('s1'),
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  db.sale.updateMany.mockResolvedValue({ count: 1 });
  db.sale.findUnique.mockResolvedValue({ ...facts, status: 'PAID' });
  db.sale.findFirst.mockResolvedValue({ ...facts, status: 'PAID' });
  db.member.findMany.mockResolvedValue([{ id: 'admin1' }]);
  db.strike.create.mockResolvedValue({ id: 'st1', expiresAt: new Date('2027-11-15T10:00:00Z') });
  db.strike.count.mockResolvedValue(1);
  db.auctionDeposit.findMany.mockResolvedValue([]);
  db.secondChanceOffer.updateMany.mockResolvedValue({ count: 0 });
  provider.fetchPaymentTransfers.mockResolvedValue([{ id: 'trf_1', account: 'acc_1', amountPaise: 95_000, onHold: true }]);
  provider.releaseTransfer.mockResolvedValue(undefined);
  db.sellerPayoutAccount.findUnique.mockResolvedValue({ status: 'ACTIVE', razorpayAccountId: 'acc_1' });
});

describe('SaleDTO', () => {
  it('hides commission / payout and the seller contact from the buyer; shows the contact once PAID', () => {
    const buyer = svc.toSaleDTO(row() as never, 'BUYER') as Record<string, unknown>;
    expect(buyer).not.toHaveProperty('commissionPaise');
    expect(buyer).not.toHaveProperty('payoutPaise');
    expect(buyer).not.toHaveProperty('buyerContact');
    expect(buyer.sellerContact).toEqual({ name: 'N-s1', email: 's1@x.test', phone: '9000000000' });
    expect(buyer.itemPaise).toBe(100_000);
  });
  it('seller sees commission, payout and the buyer contact; admin sees money but no contacts', () => {
    const seller = svc.toSaleDTO(row() as never, 'SELLER') as Record<string, unknown>;
    expect(seller).toMatchObject({ commissionPaise: 5_000, payoutPaise: 95_000, role: 'SELLER' });
    expect(seller.buyerContact).toMatchObject({ email: 'b1@x.test' });
    expect(seller).not.toHaveProperty('sellerContact');
    const admin = svc.toSaleDTO(row() as never, 'ADMIN') as Record<string, unknown>;
    expect(admin).toMatchObject({ payoutPaise: 95_000, role: 'ADMIN' });
    expect(admin).not.toHaveProperty('buyerContact');
    expect(admin).not.toHaveProperty('sellerContact');
  });
  it('no contacts before payment', () => {
    const d = svc.toSaleDTO(row({ status: 'AWAITING_PAYMENT', paidAt: null }) as never, 'BUYER') as Record<string, unknown>;
    expect(d).not.toHaveProperty('sellerContact');
  });
  it('getSaleDTO: buyer, seller and SUPER_ADMIN may read; a stranger gets 404 SALE_NOT_FOUND', async () => {
    db.sale.findUnique.mockResolvedValue(row());
    expect((await svc.getSaleDTO('sale1', { id: 'b1' })).role).toBe('BUYER');
    expect((await svc.getSaleDTO('sale1', { id: 's1' })).role).toBe('SELLER');
    expect((await svc.getSaleDTO('sale1', { id: 'x', role: 'SUPER_ADMIN' })).role).toBe('ADMIN');
    expect(await code(svc.getSaleDTO('sale1', { id: 'x', role: 'MEMBER' }))).toBe('404:SALE_NOT_FOUND');
    db.sale.findUnique.mockResolvedValue(null);
    expect(await code(svc.getSaleDTO('nope', { id: 'b1' }))).toBe('404:SALE_NOT_FOUND');
  });
  it('listMine filters by party and status', async () => {
    db.sale.findMany.mockResolvedValue([row()]);
    db.sale.count.mockResolvedValue(1);
    const r = await svc.listMine('s1', { role: 'seller', status: 'PAID', page: 1, pageSize: 20 });
    expect(db.sale.findMany.mock.calls[0][0].where).toEqual({ sellerId: 's1', status: 'PAID' });
    expect(r.items[0].role).toBe('SELLER');
    expect(r.meta).toMatchObject({ total: 1, page: 1, pageSize: 20 });
  });
});

describe('checkout', () => {
  const sale = (over: Record<string, unknown> = {}) => ({
    id: 'sale1',
    status: 'AWAITING_PAYMENT',
    payBy: new Date(now.getTime() + DAY),
    sellerId: 's1',
    amountPaise: 100_000n,
    commissionPaise: 5_000n,
    auction: { title: 'Watch' },
    ...over,
  });
  beforeEach(() => {
    db.sale.findFirst.mockResolvedValue(sale());
    db.member.findUnique.mockResolvedValue({ name: 'Buyer', email: 'b@x.test', phone: '9000000000' });
    db.paymentOrder.findFirst.mockResolvedValue(null);
    provider.createOrder.mockResolvedValue({ gatewayOrderId: 'order_1', keyId: 'rzp_key' });
  });

  it('creates an order with an ON-HOLD transfer of amount minus commission and returns the commission-style payload', async () => {
    const r = await svc.checkout('b1', 'sale1', now);
    expect(r).toEqual({
      orderId: 'order_1',
      amountPaise: 100_000,
      currency: 'INR',
      keyId: 'rzp_key',
      description: 'Payment for "Watch"',
      prefill: { name: 'Buyer', email: 'b@x.test', contact: '9000000000' },
    });
    const arg = provider.createOrder.mock.calls[0][0];
    expect(arg.amountPaise).toBe(100_000);
    expect(arg.notes).toEqual({ saleId: 'sale1', memberId: 'b1' });
    expect(arg.transfers).toEqual([{ account: 'acc_1', amountPaise: 95_000, onHold: true, notes: { saleId: 'sale1' } }]);
    expect(arg.receipt.length).toBeLessThanOrEqual(40);
    expect(db.paymentOrder.create.mock.calls[0][0].data).toMatchObject({
      memberId: 'b1',
      gatewayOrderId: 'order_1',
      referenceType: 'SALE',
      referenceId: 'sale1',
      idempotencyKey: 'sale:sale1:order_1',
    });
  });

  it('reuses a CREATED order younger than 30 minutes for the same amount', async () => {
    db.paymentOrder.findFirst.mockResolvedValue({ gatewayOrderId: 'order_old' });
    const r = await svc.checkout('b1', 'sale1', now);
    expect(r.orderId).toBe('order_old');
    expect(provider.createOrder).not.toHaveBeenCalled();
    const where = db.paymentOrder.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ referenceType: 'SALE', referenceId: 'sale1', status: 'CREATED', amountPaise: 100_000n });
    expect(where.createdAt.gte).toEqual(new Date(now.getTime() - 30 * 60_000));
  });

  it('404 for a non-buyer, 409 SALE_NOT_PAYABLE when not awaiting payment or past payBy, 409 PAYOUT_ACCOUNT_INACTIVE', async () => {
    db.sale.findFirst.mockResolvedValue(null);
    expect(await code(svc.checkout('x', 'sale1', now))).toBe('404:SALE_NOT_FOUND');
    expect(db.sale.findFirst.mock.calls[0][0].where).toEqual({ id: 'sale1', buyerId: 'x' });
    db.sale.findFirst.mockResolvedValue(sale({ status: 'PAID' }));
    expect(await code(svc.checkout('b1', 'sale1', now))).toBe('409:SALE_NOT_PAYABLE');
    db.sale.findFirst.mockResolvedValue(sale({ payBy: new Date(now.getTime() - 1) }));
    expect(await code(svc.checkout('b1', 'sale1', now))).toBe('409:SALE_NOT_PAYABLE');
    db.sale.findFirst.mockResolvedValue(sale());
    db.sellerPayoutAccount.findUnique.mockResolvedValue({ status: 'SUSPENDED', razorpayAccountId: 'acc_1' });
    expect(await code(svc.checkout('b1', 'sale1', now))).toBe('409:PAYOUT_ACCOUNT_INACTIVE');
    db.sellerPayoutAccount.findUnique.mockResolvedValue(null);
    expect(await code(svc.checkout('b1', 'sale1', now))).toBe('409:PAYOUT_ACCOUNT_INACTIVE');
    expect(provider.createOrder).not.toHaveBeenCalled();
  });
});

describe('markSalePaid', () => {
  beforeEach(() => {
    db.paymentOrder.findUnique.mockResolvedValue({ id: 'po1', referenceType: 'SALE', referenceId: 'sale1' });
    db.sale.findUnique.mockResolvedValue({ ...facts, rateBps: 500 });
  });

  it('moves AWAITING_PAYMENT -> PAID, writes a PAID commission row, stores the transfer id and notifies both', async () => {
    const r = await svc.markSalePaid({ paymentOrderId: 'po1', gatewayPaymentId: 'pay_1' }, now);
    expect(r).toEqual({ applied: true, saleId: 'sale1' });
    expect(db.sale.updateMany.mock.calls[0][0]).toEqual({
      where: { id: 'sale1', status: 'AWAITING_PAYMENT' },
      data: { status: 'PAID', paidAt: now, gatewayPaymentId: 'pay_1' },
    });
    expect(db.commission.create).toHaveBeenCalledWith({
      data: { auctionId: 'a1', sellerId: 's1', rateBps: 500, amountPaise: 5_000n, status: 'PAID', dueAt: now, paidAt: now, paymentOrderId: 'po1' },
      select: { id: true },
    });
    expect(db.paymentOrder.updateMany).toHaveBeenCalledWith({
      where: { id: 'po1', status: { not: 'PAID' } },
      data: { status: 'PAID', gatewayPaymentId: 'pay_1' },
    });
    expect(db.sale.updateMany).toHaveBeenCalledWith({ where: { id: 'sale1', transferId: null }, data: { transferId: 'trf_1' } });
    expect(enqueue.mock.calls.map((c) => c[0])).toEqual([
      expect.objectContaining({ type: 'sale-paid', memberId: 's1', dedupeKey: 'sale-paid:sale1' }),
      expect.objectContaining({ type: 'sale-receipt', memberId: 'b1', dedupeKey: 'sale-receipt:sale1' }),
    ]);
  });

  it('is idempotent: a second call (verify + webhook) changes nothing and notifies nobody', async () => {
    db.sale.updateMany.mockResolvedValue({ count: 0 });
    const r = await svc.markSalePaid({ paymentOrderId: 'po1', gatewayPaymentId: 'pay_1' }, now);
    expect(r).toEqual({ applied: false, saleId: 'sale1' });
    expect(db.commission.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('ignores an order that is not a SALE order', async () => {
    db.paymentOrder.findUnique.mockResolvedValue({ id: 'po1', referenceType: 'COMMISSION', referenceId: 'c1' });
    expect(await svc.markSalePaid({ paymentOrderId: 'po1' }, now)).toEqual({ applied: false, saleId: null });
    expect(db.sale.updateMany).not.toHaveBeenCalled();
  });

  it('a failing transfer lookup does not fail the settlement', async () => {
    provider.fetchPaymentTransfers.mockRejectedValue(new Error('gateway down'));
    const r = await svc.markSalePaid({ paymentOrderId: 'po1', gatewayPaymentId: 'pay_1' }, now);
    expect(r.applied).toBe(true);
    expect(types()).toEqual(['sale-paid', 'sale-receipt']);
  });
});

describe('ship', () => {
  it('PAID -> SHIPPED (seller only) and notifies the buyer', async () => {
    db.sale.findFirst.mockResolvedValue({ ...facts, status: 'PAID' });
    db.sale.findUnique.mockResolvedValue(row({ status: 'SHIPPED' }));
    await svc.shipSale('s1', 'sale1', { method: 'COURIER', courier: 'BlueDart', trackingNo: 'T1' }, now);
    expect(db.sale.findFirst.mock.calls[0][0].where).toEqual({ id: 'sale1', sellerId: 's1' });
    expect(db.sale.updateMany).toHaveBeenCalledWith({
      where: { id: 'sale1', status: 'PAID' },
      data: { status: 'SHIPPED', shippedAt: now, shippingMethod: 'COURIER', courier: 'BlueDart', trackingNo: 'T1' },
    });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ type: 'sale-shipped', memberId: 'b1', dedupeKey: 'sale-shipped:sale1' }));
  });
  it('404 for a non-seller; 409 SALE_INVALID_STATE when not PAID (or when the guarded update loses a race)', async () => {
    db.sale.findFirst.mockResolvedValue(null);
    expect(await code(svc.shipSale('b1', 'sale1', { method: 'PICKUP' }, now))).toBe('404:SALE_NOT_FOUND');
    for (const status of ['AWAITING_PAYMENT', 'SHIPPED', 'DELIVERED', 'RELEASED', 'DISPUTED', 'REFUNDED', 'CANCELLED']) {
      db.sale.findFirst.mockResolvedValue({ ...facts, status });
      expect(await code(svc.shipSale('s1', 'sale1', { method: 'PICKUP' }, now))).toBe('409:SALE_INVALID_STATE');
    }
    db.sale.findFirst.mockResolvedValue({ ...facts, status: 'PAID' });
    db.sale.updateMany.mockResolvedValue({ count: 0 });
    expect(await code(svc.shipSale('s1', 'sale1', { method: 'PICKUP' }, now))).toBe('409:SALE_INVALID_STATE');
  });
});

describe('confirm + release', () => {
  const state = (status: string, over: Record<string, unknown> = {}) => ({ ...facts, status, transferId: 'trf_1', ...over });

  it.each(['PAID', 'SHIPPED'])('%s -> DELIVERED -> releases the transfer -> RELEASED and notifies the seller', async (status) => {
    db.sale.findFirst.mockResolvedValue(state(status));
    db.sale.findUnique.mockResolvedValueOnce(state('DELIVERED')).mockResolvedValue(row({ status: 'RELEASED' }));
    await svc.confirmSale('b1', 'sale1', now);
    expect(db.sale.updateMany.mock.calls[0][0]).toEqual({
      where: { id: 'sale1', status: { in: ['PAID', 'SHIPPED'] } },
      data: { status: 'DELIVERED', deliveredAt: now },
    });
    expect(provider.releaseTransfer).toHaveBeenCalledWith('trf_1');
    expect(db.sale.updateMany.mock.calls[1][0]).toMatchObject({
      where: { id: 'sale1', status: { in: ['DELIVERED'] } },
      data: { status: 'RELEASED', releasedAt: now },
    });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ type: 'sale-released', memberId: 's1', dedupeKey: 'sale-released:sale1' }));
  });

  it('fetches the transfer first when transferId is null and stores it', async () => {
    db.sale.findFirst.mockResolvedValue(state('SHIPPED', { transferId: null }));
    db.sale.findUnique.mockResolvedValueOnce(state('DELIVERED', { transferId: null })).mockResolvedValue(row({ status: 'RELEASED' }));
    await svc.confirmSale('b1', 'sale1', now);
    expect(provider.fetchPaymentTransfers).toHaveBeenCalledWith('pay_1');
    expect(db.sale.updateMany).toHaveBeenCalledWith({ where: { id: 'sale1', transferId: null }, data: { transferId: 'trf_1' } });
    expect(provider.releaseTransfer).toHaveBeenCalledWith('trf_1');
  });

  it('a gateway failure keeps the sale DELIVERED (no RELEASED update, no seller notice) and does not throw', async () => {
    db.sale.findFirst.mockResolvedValue(state('SHIPPED'));
    db.sale.findUnique.mockResolvedValueOnce(state('DELIVERED')).mockResolvedValue(row({ status: 'DELIVERED' }));
    provider.releaseTransfer.mockRejectedValue(new Error('gateway down'));
    const dto = await svc.confirmSale('b1', 'sale1', now);
    expect(dto.status).toBe('DELIVERED');
    expect(db.sale.updateMany).toHaveBeenCalledTimes(1); // only the DELIVERED transition
    expect(types()).not.toContain('sale-released');
  });

  it('404 for a non-buyer; 409 SALE_INVALID_STATE outside PAID / SHIPPED', async () => {
    db.sale.findFirst.mockResolvedValue(null);
    expect(await code(svc.confirmSale('s1', 'sale1', now))).toBe('404:SALE_NOT_FOUND');
    expect(db.sale.findFirst.mock.calls[0][0].where).toEqual({ id: 'sale1', buyerId: 's1' });
    for (const status of ['AWAITING_PAYMENT', 'DELIVERED', 'RELEASED', 'DISPUTED', 'REFUNDED', 'CANCELLED']) {
      db.sale.findFirst.mockResolvedValue(state(status));
      expect(await code(svc.confirmSale('b1', 'sale1', now))).toBe('409:SALE_INVALID_STATE');
    }
  });

  it('a release qualifies the referral of buyer and seller; a failed release does not', async () => {
    db.sale.findUnique.mockResolvedValue({ ...state('DELIVERED'), transferId: 'trf_1' });
    db.sale.updateMany.mockResolvedValue({ count: 1 });
    provider.releaseTransfer.mockResolvedValue(undefined);
    await svc.releaseSale('sale1', { from: ['DELIVERED'] }, now);
    expect(referral.qualifyReferralBestEffort).toHaveBeenCalledWith(['b1', 's1'], now);
    referral.qualifyReferralBestEffort.mockClear();
    provider.releaseTransfer.mockRejectedValue(new Error('gateway down'));
    await svc.releaseSale('sale1', { from: ['DELIVERED'] }, now);
    expect(referral.qualifyReferralBestEffort).not.toHaveBeenCalled();
  });

  it('releaseSale does nothing when the sale is not in an allowed state', async () => {
    db.sale.findUnique.mockResolvedValue(state('DISPUTED'));
    expect(await svc.releaseSale('sale1', { from: ['DELIVERED'] }, now)).toEqual({ released: false });
    expect(provider.releaseTransfer).not.toHaveBeenCalled();
  });
});

describe('dispute', () => {
  it.each(['PAID', 'SHIPPED', 'DELIVERED'])('%s -> DISPUTED and notifies the seller and every SUPER_ADMIN', async (status) => {
    db.sale.findFirst.mockResolvedValue({ ...facts, status });
    db.sale.findUnique.mockResolvedValue(row({ status: 'DISPUTED' }));
    db.member.findMany.mockResolvedValue([{ id: 'admin1' }, { id: 'admin2' }]);
    await svc.disputeSale('b1', 'sale1', 'Item never arrived at all', now);
    expect(db.sale.updateMany.mock.calls[0][0]).toEqual({
      where: { id: 'sale1', status: { in: ['PAID', 'SHIPPED', 'DELIVERED'] } },
      data: { status: 'DISPUTED', disputedAt: now, disputeReason: 'Item never arrived at all' },
    });
    expect(db.member.findMany.mock.calls[0][0].where).toEqual({ role: 'SUPER_ADMIN', isActive: true });
    expect(enqueue.mock.calls.map((c) => (c[0] as { memberId: string; dedupeKey: string }).dedupeKey)).toEqual([
      'sale-disputed:sale1',
      'sale-disputed:sale1:admin1',
      'sale-disputed:sale1:admin2',
    ]);
  });
  it('404 for a non-buyer; 409 for RELEASED / REFUNDED / CANCELLED / AWAITING_PAYMENT / DISPUTED', async () => {
    db.sale.findFirst.mockResolvedValue(null);
    expect(await code(svc.disputeSale('s1', 'sale1', 'x'.repeat(12), now))).toBe('404:SALE_NOT_FOUND');
    for (const status of ['RELEASED', 'REFUNDED', 'CANCELLED', 'AWAITING_PAYMENT', 'DISPUTED']) {
      db.sale.findFirst.mockResolvedValue({ ...facts, status });
      expect(await code(svc.disputeSale('b1', 'sale1', 'x'.repeat(12), now))).toBe('409:SALE_INVALID_STATE');
    }
  });
});

describe('admin release / refund', () => {
  it('release: DISPUTED -> RELEASED stamps the resolution; wrong state 409; gateway failure 502', async () => {
    db.sale.findUnique
      .mockResolvedValueOnce({ status: 'DISPUTED' })
      .mockResolvedValueOnce({ ...facts, status: 'DISPUTED', transferId: 'trf_1' })
      .mockResolvedValue(row({ status: 'RELEASED' }));
    await adminRelease('sale1', 'admin1');
    expect(db.sale.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'RELEASED', resolution: 'RELEASED_BY_ADMIN' });
    expect(db.sale.updateMany.mock.calls[0][0].data.resolvedAt).toBeInstanceOf(Date);

    db.sale.findUnique.mockReset();
    db.sale.findUnique.mockResolvedValue({ status: 'PAID' });
    expect(await code(adminRelease('sale1', 'admin1'))).toBe('409:SALE_INVALID_STATE');
    db.sale.findUnique.mockReset();
    db.sale.findUnique.mockResolvedValueOnce({ status: 'DELIVERED' }).mockResolvedValue({ ...facts, status: 'DELIVERED', transferId: 'trf_1' });
    provider.releaseTransfer.mockRejectedValue(new Error('down'));
    expect(await code(adminRelease('sale1', 'admin1'))).toBe('502:RELEASE_FAILED');
    db.sale.findUnique.mockReset();
    db.sale.findUnique.mockResolvedValue(null);
    expect(await code(adminRelease('nope', 'admin1'))).toBe('404:SALE_NOT_FOUND');
  });

  it('refund: refunds with reverse_all, marks REFUNDED, waives the PAID commission, notifies both', async () => {
    provider.refundPayment.mockResolvedValue({ id: 'rfnd_1' });
    db.sale.findUnique.mockResolvedValueOnce({ ...facts, status: 'DISPUTED' }).mockResolvedValue(row({ status: 'REFUNDED' }));
    await adminRefund('sale1', 'admin1', 'Item lost', now);
    expect(provider.refundPayment).toHaveBeenCalledWith('pay_1', { amountPaise: 100_000, reverseAll: true });
    expect(db.sale.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 'sale1', status: { in: ['PAID', 'SHIPPED', 'DELIVERED', 'DISPUTED'] } },
      data: { status: 'REFUNDED', refundedAt: now, resolvedAt: now, resolution: 'REFUNDED: Item lost' },
    });
    expect(db.commission.updateMany).toHaveBeenCalledWith({ where: { auctionId: 'a1', status: 'PAID' }, data: { status: 'WAIVED' } });
    expect(enqueue.mock.calls.map((c) => (c[0] as { dedupeKey: string }).dedupeKey)).toEqual(['sale-refunded:sale1:b1', 'sale-refunded:sale1:s1']);
  });
  it('refund: 409 for RELEASED / CANCELLED / AWAITING_PAYMENT / REFUNDED, 404 unknown; no gateway call', async () => {
    for (const status of ['RELEASED', 'CANCELLED', 'AWAITING_PAYMENT', 'REFUNDED']) {
      db.sale.findUnique.mockResolvedValue({ ...facts, status });
      expect(await code(adminRefund('sale1', 'admin1'))).toBe('409:SALE_INVALID_STATE');
    }
    db.sale.findUnique.mockResolvedValue(null);
    expect(await code(adminRefund('nope', 'admin1'))).toBe('404:SALE_NOT_FOUND');
    expect(provider.refundPayment).not.toHaveBeenCalled();
  });
});

describe('runSalesMaintenance', () => {
  const unpaid = { id: 'u1', auctionId: 'a1', buyerId: 'b1', sellerId: 's1', amountPaise: 100n, commissionPaise: 5n };

  it('cancels unpaid sales past payBy and notifies both', async () => {
    db.sale.findMany.mockResolvedValueOnce([unpaid]).mockResolvedValue([]);
    const counts = await runSalesMaintenance(now);
    expect(counts).toEqual({ cancelled: 1, autoConfirmed: 0, releaseRetried: 0, depositsRefunded: 0, depositsForfeited: 0, offersExpired: 0 });
    expect(db.sale.findMany.mock.calls[0][0].where).toEqual({ status: 'AWAITING_PAYMENT', payBy: { lt: now } });
    expect(db.sale.updateMany).toHaveBeenCalledWith({
      where: { id: 'u1', status: 'AWAITING_PAYMENT' },
      data: { status: 'CANCELLED', cancelledAt: now },
    });
    expect(enqueue.mock.calls.map((c) => (c[0] as { dedupeKey: string }).dedupeKey)).toEqual([
      'sale-cancelled:u1:b1',
      'sale-cancelled:u1:s1',
      'strike-issued:st1',
    ]);
  });

  describe('strikes on cancel', () => {
    const cancelWith = async (activeCount: number) => {
      db.sale.findMany.mockResolvedValueOnce([unpaid]).mockResolvedValue([]);
      db.strike.count.mockResolvedValue(activeCount);
      await runSalesMaintenance(now);
    };
    const sent = (type: string) => enqueue.mock.calls.map((c) => c[0] as { type: string; data?: Record<string, unknown> }).filter((m) => m.type === type);

    it('creates the UNPAID strike in the same transaction as the cancel, expiring in 12 months', async () => {
      await cancelWith(1);
      expect(db.$transaction).toHaveBeenCalled();
      expect(db.strike.create).toHaveBeenCalledWith({
        data: { memberId: 'b1', saleId: 'u1', reason: 'UNPAID', expiresAt: new Date('2027-11-15T10:00:00Z') },
        select: { id: true, expiresAt: true },
      });
      expect(db.strike.count.mock.calls[0][0].where).toEqual({ memberId: 'b1', removedAt: null, expiresAt: { gt: now } });
    });
    it('1 active strike: a warning only', async () => {
      await cancelWith(1);
      expect(sent('strike-issued')[0].data).toMatchObject({ strikeCount: 1, depositsRequired: false });
      expect(db.member.update).not.toHaveBeenCalled();
    });
    it('2 active strikes: the notice says deposits are now required', async () => {
      await cancelWith(2);
      expect(sent('strike-issued')[0].data).toMatchObject({ strikeCount: 2, depositsRequired: true });
      expect(db.member.update).not.toHaveBeenCalled();
    });
    it('3 active strikes: account-suspended, member deactivated, sessions and connections killed', async () => {
      await cancelWith(3);
      expect(sent('strike-issued')).toHaveLength(0);
      expect(sent('account-suspended')).toHaveLength(1);
      expect(db.member.update).toHaveBeenCalledWith({ where: { id: 'b1' }, data: { isActive: false } });
      expect(db.session.deleteMany).toHaveBeenCalledWith({ where: { memberId: 'b1' } });
      expect(disconnect).toHaveBeenCalledWith('b1');
    });
    it('no strike when the cancel was a no-op (already moved)', async () => {
      db.sale.findMany.mockResolvedValueOnce([unpaid]).mockResolvedValue([]);
      db.sale.updateMany.mockResolvedValue({ count: 0 });
      await runSalesMaintenance(now);
      expect(db.strike.create).not.toHaveBeenCalled();
    });
  });

  it('expires pending second-chance offers and runs the deposit release', async () => {
    db.sale.findMany.mockResolvedValue([]);
    db.secondChanceOffer.updateMany.mockResolvedValue({ count: 2 });
    const counts = await runSalesMaintenance(now);
    expect(counts.offersExpired).toBe(2);
    expect(db.secondChanceOffer.updateMany).toHaveBeenCalledWith({
      where: { status: 'PENDING', expiresAt: { lte: now } },
      data: { status: 'EXPIRED' },
    });
    expect(db.auctionDeposit.findMany).toHaveBeenCalled();
  });

  it('is idempotent: a sale that already moved is skipped silently', async () => {
    db.sale.findMany.mockResolvedValueOnce([unpaid]).mockResolvedValue([]);
    db.sale.updateMany.mockResolvedValue({ count: 0 });
    expect(await runSalesMaintenance(now)).toEqual({ cancelled: 0, autoConfirmed: 0, releaseRetried: 0, depositsRefunded: 0, depositsForfeited: 0, offersExpired: 0 });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('auto-confirms SHIPPED sales older than 7 days and releases them', async () => {
    db.sale.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'sale1' }]).mockResolvedValue([]);
    db.sale.findUnique.mockResolvedValue({ ...facts, status: 'DELIVERED', transferId: 'trf_1' });
    const counts = await runSalesMaintenance(now);
    expect(counts.autoConfirmed).toBe(1);
    expect(db.sale.findMany.mock.calls[1][0].where).toEqual({ status: 'SHIPPED', shippedAt: { lt: new Date(now.getTime() - 7 * DAY) } });
    expect(db.sale.updateMany.mock.calls[0][0]).toEqual({
      where: { id: 'sale1', status: 'SHIPPED' },
      data: { status: 'DELIVERED', deliveredAt: now },
    });
    expect(provider.releaseTransfer).toHaveBeenCalledWith('trf_1');
    expect(types()).toContain('sale-released');
  });

  it('retries the release of DELIVERED sales; a failure is logged and skipped, the batch continues', async () => {
    db.sale.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'x1' }, { id: 'x2' }]);
    db.sale.findUnique
      .mockResolvedValueOnce({ ...facts, id: 'x1', status: 'DELIVERED', transferId: 'trf_x1' })
      .mockResolvedValueOnce({ ...facts, id: 'x2', status: 'DELIVERED', transferId: 'trf_x2' });
    provider.releaseTransfer.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(undefined);
    const counts = await runSalesMaintenance(now);
    expect(counts.releaseRetried).toBe(1);
    expect(db.sale.findMany.mock.calls[2][0].where).toEqual({ status: 'DELIVERED', releasedAt: null });
    expect(provider.releaseTransfer).toHaveBeenCalledTimes(2);
  });

  it('every query is batch-limited', async () => {
    db.sale.findMany.mockResolvedValue([]);
    await runSalesMaintenance(now);
    for (const c of db.sale.findMany.mock.calls) expect(c[0].take).toBe(100);
  });
});

describe('sales validation', () => {
  it('ship: COURIER needs a courier, PICKUP does not; lengths capped at 60', () => {
    expect(shipSchema.validate({ method: 'COURIER' }).error).toBeDefined();
    expect(shipSchema.validate({ method: 'COURIER', courier: 'BlueDart' }).error).toBeUndefined();
    expect(shipSchema.validate({ method: 'PICKUP' }).error).toBeUndefined();
    expect(shipSchema.validate({ method: 'AIR' }).error).toBeDefined();
    expect(shipSchema.validate({ method: 'COURIER', courier: 'x'.repeat(61) }).error).toBeDefined();
    expect(shipSchema.validate({ method: 'PICKUP', trackingNo: 'x'.repeat(61) }).error).toBeDefined();
  });
  it('dispute reason is 10..1000 chars', () => {
    expect(disputeSchema.validate({ reason: 'short' }).error).toBeDefined();
    expect(disputeSchema.validate({ reason: 'x'.repeat(10) }).error).toBeUndefined();
    expect(disputeSchema.validate({ reason: 'x'.repeat(1001) }).error).toBeDefined();
  });
  it('mine query: role and status are bounded, status is case-insensitive', () => {
    expect(mineQuerySchema.validate({ role: 'admin' }).error).toBeDefined();
    expect(mineQuerySchema.validate({ status: 'nope' }).error).toBeDefined();
    expect(mineQuerySchema.validate({ limit: 101 }).error).toBeDefined();
    expect(mineQuerySchema.validate({ status: 'paid', role: 'seller' }).value).toMatchObject({ status: 'PAID', role: 'seller', page: 1 });
  });
});
