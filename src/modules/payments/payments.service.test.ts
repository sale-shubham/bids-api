import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  paymentOrder: { findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  webhookEvent: { findUnique: vi.fn(), create: vi.fn() },
}));
const provider = vi.hoisted(() => ({
  verifyPaymentSignature: vi.fn(),
  fetchPayment: vi.fn(),
  verifyWebhook: vi.fn(),
}));
const settle = vi.hoisted(() => ({
  markCommissionPaid: vi.fn(),
  getCommissionDTO: vi.fn(),
}));

vi.mock('@/core/prisma/client', () => ({ prisma: db }));
vi.mock('@/core/logger/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/providers/payment', () => ({ paymentProvider: provider }));
vi.mock('@/modules/commissions/commissions.service', () => settle);

import { handleWebhook, verifyPayment } from './payments.service';
import { StubPayment } from '@/providers/payment/stub.payment';

const order = { id: 'po1', memberId: 'm1', gatewayOrderId: 'order_1', amountPaise: 50_000, status: 'CREATED' };
const input = { orderId: 'order_1', paymentId: 'pay_1', signature: 'sig' };

beforeEach(() => {
  vi.clearAllMocks();
  db.paymentOrder.findFirst.mockResolvedValue(order);
  db.paymentOrder.findUnique.mockResolvedValue(order);
  db.paymentOrder.updateMany.mockResolvedValue({ count: 1 });
  db.webhookEvent.findUnique.mockResolvedValue(null);
  db.webhookEvent.create.mockResolvedValue({});
  provider.verifyPaymentSignature.mockReturnValue(true);
  provider.verifyWebhook.mockReturnValue(true);
  provider.fetchPayment.mockResolvedValue({ status: 'captured', amountPaise: 50_000 });
  settle.markCommissionPaid.mockResolvedValue({ applied: true, commissionId: 'c1' });
  settle.getCommissionDTO.mockResolvedValue({ id: 'c1', status: 'PAID' });
});

describe('verifyPayment', () => {
  it('settles and returns the commission', async () => {
    const r = await verifyPayment('m1', input);
    expect(r).toEqual({ commission: { id: 'c1', status: 'PAID' } });
    expect(settle.markCommissionPaid).toHaveBeenCalledWith({ paymentOrderId: 'po1', gatewayPaymentId: 'pay_1' });
  });

  it('404 ORDER_NOT_FOUND for unknown / other member order', async () => {
    db.paymentOrder.findFirst.mockResolvedValue(null);
    await expect(verifyPayment('m2', input)).rejects.toMatchObject({ statusCode: 404, code: 'ORDER_NOT_FOUND' });
    expect(db.paymentOrder.findFirst.mock.calls[0][0].where).toEqual({ gatewayOrderId: 'order_1', memberId: 'm2' });
  });

  it('400 INVALID_SIGNATURE', async () => {
    provider.verifyPaymentSignature.mockReturnValue(false);
    await expect(verifyPayment('m1', input)).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_SIGNATURE' });
    expect(settle.markCommissionPaid).not.toHaveBeenCalled();
  });

  it('409 PAYMENT_NOT_CAPTURED for a failed payment; accepts authorized', async () => {
    provider.fetchPayment.mockResolvedValue({ status: 'failed', amountPaise: 50_000 });
    await expect(verifyPayment('m1', input)).rejects.toMatchObject({ statusCode: 409, code: 'PAYMENT_NOT_CAPTURED' });
    provider.fetchPayment.mockResolvedValue({ status: 'authorized', amountPaise: 50_000 });
    await expect(verifyPayment('m1', input)).resolves.toBeDefined();
  });

  it('409 AMOUNT_MISMATCH; null amount (stub) skips the check', async () => {
    provider.fetchPayment.mockResolvedValue({ status: 'captured', amountPaise: 100 });
    await expect(verifyPayment('m1', input)).rejects.toMatchObject({ statusCode: 409, code: 'AMOUNT_MISMATCH' });
    expect(settle.markCommissionPaid).not.toHaveBeenCalled();
    provider.fetchPayment.mockResolvedValue({ status: 'captured', amountPaise: null });
    await expect(verifyPayment('m1', input)).resolves.toBeDefined();
  });
});

describe('stub driver signature rule', () => {
  const stub = new StubPayment();
  it("accepts only signature 'stub'", () => {
    expect(stub.verifyPaymentSignature({ orderId: 'o', paymentId: 'p', signature: 'stub' })).toBe(true);
    expect(stub.verifyPaymentSignature({ orderId: 'o', paymentId: 'p', signature: 'anything' })).toBe(false);
    expect(stub.verifyPaymentSignature({ orderId: 'o', paymentId: 'p', signature: '' })).toBe(false);
  });
});

const captured = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1', ...extra } } },
  });

describe('handleWebhook', () => {
  it('rejects an invalid signature', async () => {
    provider.verifyWebhook.mockReturnValue(false);
    await expect(handleWebhook(captured(), 'bad', 'evt1')).rejects.toMatchObject({ statusCode: 400 });
    expect(settle.markCommissionPaid).not.toHaveBeenCalled();
  });

  it('payment.captured settles the order found by gateway order id', async () => {
    expect(await handleWebhook(captured(), 'sig', 'evt1')).toEqual({ processed: true });
    expect(db.paymentOrder.findUnique).toHaveBeenCalledWith({ where: { gatewayOrderId: 'order_1' } });
    expect(settle.markCommissionPaid).toHaveBeenCalledWith({ paymentOrderId: 'po1', gatewayPaymentId: 'pay_1' });
    expect(db.webhookEvent.create).toHaveBeenCalledOnce();
  });

  it('order.paid settles using the order entity id', async () => {
    const raw = JSON.stringify({
      event: 'order.paid',
      payload: { order: { entity: { id: 'order_1' } }, payment: { entity: { id: 'pay_9', order_id: 'order_1' } } },
    });
    await handleWebhook(raw, 'sig', 'evt2');
    expect(settle.markCommissionPaid).toHaveBeenCalledWith({ paymentOrderId: 'po1', gatewayPaymentId: 'pay_9' });
  });

  it('falls back to the commissionId note when the order id is unknown', async () => {
    db.paymentOrder.findUnique.mockResolvedValue(null);
    db.paymentOrder.findFirst.mockResolvedValue(order);
    await handleWebhook(captured({ notes: { commissionId: 'c1' } }), 'sig', 'evt3');
    expect(db.paymentOrder.findFirst.mock.calls[0][0].where).toEqual({ referenceType: 'COMMISSION', referenceId: 'c1' });
    expect(settle.markCommissionPaid).toHaveBeenCalled();
  });

  it('payment.failed marks a CREATED order FAILED and does not settle', async () => {
    const raw = JSON.stringify({
      event: 'payment.failed',
      payload: { payment: { entity: { id: 'pay_2', order_id: 'order_1' } } },
    });
    await handleWebhook(raw, 'sig', 'evt4');
    expect(db.paymentOrder.updateMany).toHaveBeenCalledWith({
      where: { id: 'po1', status: 'CREATED' },
      data: { status: 'FAILED' },
    });
    expect(settle.markCommissionPaid).not.toHaveBeenCalled();
  });

  it('duplicate event id is skipped without side effects', async () => {
    db.webhookEvent.findUnique.mockResolvedValue({ id: 'w1' });
    expect(await handleWebhook(captured(), 'sig', 'evt1')).toEqual({ skipped: true });
    expect(settle.markCommissionPaid).not.toHaveBeenCalled();
    expect(db.webhookEvent.create).not.toHaveBeenCalled();
  });

  it('unknown event / unknown order still succeeds (200)', async () => {
    expect(await handleWebhook(JSON.stringify({ event: 'refund.created' }), 'sig', 'evt5')).toEqual({ processed: true });
    db.paymentOrder.findUnique.mockResolvedValue(null);
    expect(await handleWebhook(captured(), 'sig', 'evt6')).toEqual({ processed: true });
    expect(settle.markCommissionPaid).not.toHaveBeenCalled();
  });
});
