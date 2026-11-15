import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/core/config/env', () => ({
  env: { payment: { razorpay: { keyId: 'rzp_k', keySecret: 'sec', webhookSecret: 'wh' } } },
}));

import { RazorpayPayment } from './razorpay.payment';
import { StubPayment } from './stub.payment';
import { mapActivationStatus } from './route-status';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
const reply = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body });
const call = (i: number) => {
  const [url, init] = fetchMock.mock.calls[i];
  return { url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined };
};

afterEach(() => fetchMock.mockReset());

describe('RazorpayPayment (Route)', () => {
  const rzp = new RazorpayPayment();

  it('createOrder without transfers keeps the old body', async () => {
    fetchMock.mockResolvedValue(reply({ id: 'order_1' }));
    await rzp.createOrder({ amountPaise: 500, receipt: 'r', notes: { a: '1' } });
    expect(call(0).body).toEqual({ amount: 500, currency: 'INR', receipt: 'r', notes: { a: '1' } });
  });

  it('createOrder with transfers sends on-hold transfers and partial_payment off', async () => {
    fetchMock.mockResolvedValue(reply({ id: 'order_1' }));
    await rzp.createOrder({
      amountPaise: 100_000,
      receipt: 'r',
      transfers: [{ account: 'acc_1', amountPaise: 95_000, onHold: true, notes: { saleId: 's1' } }],
    });
    expect(call(0).body).toMatchObject({
      amount: 100_000,
      partial_payment: false,
      transfers: [{ account: 'acc_1', amount: 95_000, currency: 'INR', on_hold: true, notes: { saleId: 's1' } }],
    });
  });

  it('fetchPaymentTransfers / releaseTransfer / refundPayment hit the Route endpoints', async () => {
    fetchMock.mockResolvedValueOnce(reply({ items: [{ id: 'trf_1', recipient: 'acc_1', amount: 95_000, on_hold: true }] }));
    expect(await rzp.fetchPaymentTransfers('pay_1')).toEqual([{ id: 'trf_1', account: 'acc_1', amountPaise: 95_000, onHold: true }]);
    expect(call(0)).toMatchObject({ url: 'https://api.razorpay.com/v1/payments/pay_1/transfers', method: 'GET' });

    fetchMock.mockResolvedValueOnce(reply({}));
    await rzp.releaseTransfer('trf_1');
    expect(call(1)).toMatchObject({ url: 'https://api.razorpay.com/v1/transfers/trf_1', method: 'PATCH', body: { on_hold: false } });

    fetchMock.mockResolvedValueOnce(reply({ id: 'rfnd_1' }));
    expect(await rzp.refundPayment('pay_1', { amountPaise: 100_000, reverseAll: true })).toEqual({ id: 'rfnd_1' });
    expect(call(2)).toMatchObject({
      url: 'https://api.razorpay.com/v1/payments/pay_1/refund',
      method: 'POST',
      body: { amount: 100_000, reverse_all: 1 },
    });
  });

  it('a gateway error surfaces its description', async () => {
    fetchMock.mockResolvedValue(reply({ error: { description: 'nope' } }, false, 400));
    await expect(rzp.releaseTransfer('trf_1')).rejects.toThrow(/400 - nope|400 \S+ nope/);
  });

  it('createRouteAccount makes the 4 v2 calls in order and maps the activation status', async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ id: 'acc_1' }))
      .mockResolvedValueOnce(reply({ id: 'sth_1' }))
      .mockResolvedValueOnce(reply({ id: 'acc_prd_1', activation_status: 'needs_clarification' }))
      .mockResolvedValueOnce(reply({ activation_status: 'under_review' }));
    const r = await rzp.createRouteAccount({
      email: 'a@x.test',
      phone: '9876543210',
      legalName: 'Asha Rao',
      businessType: 'individual',
      contactName: 'Asha',
      referenceId: 'm1',
      pan: 'ABCDE1234F',
      address: { street1: '12 MG Road', city: 'Pune', state: 'Maharashtra', postalCode: '411001' },
      bank: { accountNumber: '123456789012', ifsc: 'HDFC0001234', beneficiaryName: 'Asha Rao' },
    });
    expect(r).toEqual({ accountId: 'acc_1', productId: 'acc_prd_1', status: 'PENDING' });
    expect([0, 1, 2, 3].map((i) => `${call(i).method} ${call(i).url.replace('https://api.razorpay.com', '')}`)).toEqual([
      'POST /v2/accounts',
      'POST /v2/accounts/acc_1/stakeholders',
      'POST /v2/accounts/acc_1/products',
      'PATCH /v2/accounts/acc_1/products/acc_prd_1',
    ]);
    expect(call(0).body).toMatchObject({ type: 'route', reference_id: 'm1', legal_info: { pan: 'ABCDE1234F' } });
    expect(call(2).body).toEqual({ product_name: 'route', tnc_accepted: true });
    expect(call(3).body).toEqual({
      settlements: { account_number: '123456789012', ifsc_code: 'HDFC0001234', beneficiary_name: 'Asha Rao' },
      tnc_accepted: true,
    });
  });
});

describe('mapActivationStatus', () => {
  it.each([
    ['activated', 'ACTIVE'],
    ['needs_clarification', 'NEEDS_CLARIFICATION'],
    ['suspended', 'SUSPENDED'],
    ['rejected', 'REJECTED'],
    ['under_review', 'PENDING'],
    ['requested', 'PENDING'],
    [undefined, 'PENDING'],
  ])('%s -> %s', (raw, expected) => {
    expect(mapActivationStatus(raw)).toBe(expected);
  });
});

describe('StubPayment (Route)', () => {
  const stub = new StubPayment();
  it('returns deterministic fake ids and an ACTIVE account immediately', async () => {
    const input = { referenceId: 'm1' } as never;
    const a = await stub.createRouteAccount(input);
    expect(a).toMatchObject({ status: 'ACTIVE' });
    expect(a.accountId).toMatch(/^acc_stub_/);
    expect((await stub.createRouteAccount(input)).accountId).toBe(a.accountId);
    expect((await stub.refundPayment('pay_1')).id).toMatch(/^rfnd_stub_/);
    await expect(stub.releaseTransfer()).resolves.toBeUndefined();
  });
  it('fetchPaymentTransfers returns one held transfer for the order account', async () => {
    await stub.createOrder({ transfers: [{ account: 'acc_stub_x', amountPaise: 900, onHold: true }] });
    const t = await stub.fetchPaymentTransfers('pay_1');
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ account: 'acc_stub_x', amountPaise: 900, onHold: true });
    expect(t[0].id).toMatch(/^trf_stub_/);
  });
});
