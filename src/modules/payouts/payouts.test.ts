import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  member: { findUnique: vi.fn() },
  sellerPayoutAccount: { findUnique: vi.fn(), upsert: vi.fn() },
}));
const provider = vi.hoisted(() => ({ createRouteAccount: vi.fn() }));
vi.mock('@/core/prisma/client', () => ({ prisma: db }));
vi.mock('@/providers/payment', () => ({ paymentProvider: provider }));

import { createAccount, getAccount } from './payouts.service';
import { createAccountSchema } from './payouts.validation';

const valid = {
  legalName: 'Asha Rao',
  businessType: 'individual',
  phone: '9876543210',
  pan: 'ABCDE1234F',
  accountNumber: '123456789012',
  ifsc: 'HDFC0001234',
  beneficiaryName: 'Asha Rao',
  address: { street1: '12 MG Road', city: 'Pune', state: 'Maharashtra', postalCode: '411001' },
};
const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => `${e.statusCode}:${e.code}`,
  );

describe('createAccountSchema', () => {
  it('accepts a valid body and upper-cases PAN / IFSC', () => {
    const { error, value } = createAccountSchema.validate({ ...valid, pan: 'abcde1234f', ifsc: 'hdfc0001234' });
    expect(error).toBeUndefined();
    expect(value).toMatchObject({ pan: 'ABCDE1234F', ifsc: 'HDFC0001234' });
  });
  it.each([
    ['pan', 'ABCDE12345'],
    ['pan', 'ABCD1234F'],
    ['ifsc', 'HDFC1001234'],
    ['ifsc', 'HDFC000123'],
    ['accountNumber', '12345678'],
    ['accountNumber', '1'.repeat(19)],
    ['accountNumber', '12345678a'],
    ['phone', '5876543210'],
    ['phone', '98765'],
    ['businessType', 'company'],
    ['legalName', 'x'.repeat(121)],
    ['beneficiaryName', 'x'.repeat(121)],
  ])('rejects bad %s (%s)', (field, bad) => {
    expect(createAccountSchema.validate({ ...valid, [field]: bad }).error).toBeDefined();
  });
  it('validates the address', () => {
    expect(createAccountSchema.validate({ ...valid, address: { ...valid.address, postalCode: '4110' } }).error).toBeDefined();
    expect(createAccountSchema.validate({ ...valid, address: { ...valid.address, street1: 'x'.repeat(101) } }).error).toBeDefined();
    expect(createAccountSchema.validate({ ...valid, address: undefined }).error).toBeDefined();
  });
});

describe('createAccount', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    db.member.findUnique.mockResolvedValue({ id: 'm1', email: 'a@x.test', name: 'Asha' });
    db.sellerPayoutAccount.findUnique.mockResolvedValue(null);
    provider.createRouteAccount.mockResolvedValue({ accountId: 'acc_1', productId: 'prd_1', status: 'PENDING' });
    db.sellerPayoutAccount.upsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => create);
  });

  it('calls the provider with the member identity, stores ids + status + last 4 only (never PAN / full account number)', async () => {
    const { account } = await createAccount('m1', valid as never);
    expect(provider.createRouteAccount).toHaveBeenCalledWith({
      email: 'a@x.test',
      phone: '9876543210',
      legalName: 'Asha Rao',
      businessType: 'individual',
      contactName: 'Asha',
      referenceId: 'm1',
      pan: 'ABCDE1234F',
      address: valid.address,
      bank: { accountNumber: '123456789012', ifsc: 'HDFC0001234', beneficiaryName: 'Asha Rao' },
    });
    const stored = JSON.stringify(db.sellerPayoutAccount.upsert.mock.calls[0][0]);
    expect(stored).not.toContain('ABCDE1234F');
    expect(stored).not.toContain('123456789012');
    expect(account).toMatchObject({ razorpayAccountId: 'acc_1', productId: 'prd_1', status: 'PENDING', bankLast4: '9012' });
  });

  it('409 PAYOUT_ACCOUNT_EXISTS for any non-REJECTED account, no gateway call', async () => {
    for (const status of ['PENDING', 'ACTIVE', 'NEEDS_CLARIFICATION', 'SUSPENDED']) {
      db.sellerPayoutAccount.findUnique.mockResolvedValue({ status });
      expect(await code(createAccount('m1', valid as never))).toBe('409:PAYOUT_ACCOUNT_EXISTS');
    }
    expect(provider.createRouteAccount).not.toHaveBeenCalled();
  });

  it('a REJECTED account may be replaced (fresh reference id, upsert update)', async () => {
    db.sellerPayoutAccount.findUnique.mockResolvedValue({ status: 'REJECTED' });
    expect(await code(createAccount('m1', valid as never, new Date('2026-11-15T10:00:00Z')))).toBe('ok');
    expect(provider.createRouteAccount.mock.calls[0][0].referenceId).toMatch(/^m1_[a-z0-9]+$/);
    expect(db.sellerPayoutAccount.upsert.mock.calls[0][0].where).toEqual({ sellerId: 'm1' });
  });

  it('getAccount returns null when there is none', async () => {
    db.sellerPayoutAccount.findUnique.mockResolvedValue(null);
    expect(await getAccount('m1')).toEqual({ account: null });
  });
});
