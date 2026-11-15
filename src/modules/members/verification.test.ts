import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  member: { findUnique: vi.fn(), update: vi.fn() },
  memberCredit: { aggregate: vi.fn(async () => ({ _sum: { amountPaise: null } })), groupBy: vi.fn(async () => [] as unknown[]) },
}));
vi.mock('@/core/prisma/client', () => ({ prisma: db }));
vi.mock('@/core/config/env', () => ({ env: { storage: { cdnBaseUrl: 'https://cdn.test', s3: { bucket: '', region: 'ap-south-1' } } } }));
vi.mock('@/modules/settings/device-limit.service', () => ({ getMaxDevicesForRole: async () => 3 }));

import { isSellerVerified, refreshSellerVerification } from './verification.service';
import { updateProfile } from './members.service';
import { updateMember } from '@/modules/admin/members/admin-members.service';
import { listWhere } from '@/modules/auctions/auctions.query';
import { toCard } from '@/modules/auctions/auctions.serializer';

const base = { role: 'AUCTIONEER', payoutStatus: 'ACTIVE', verificationRevokedAt: null };

describe('isSellerVerified matrix', () => {
  it('verified only with AUCTIONEER + ACTIVE payout + not revoked', () => {
    expect(isSellerVerified(base)).toBe(true);
    expect(isSellerVerified({ ...base, role: 'BIDDER' })).toBe(false);
    expect(isSellerVerified({ ...base, role: 'SUPER_ADMIN' })).toBe(false);
    expect(isSellerVerified({ ...base, payoutStatus: null })).toBe(false);
    for (const s of ['PENDING', 'NEEDS_CLARIFICATION', 'SUSPENDED', 'REJECTED']) {
      expect(isSellerVerified({ ...base, payoutStatus: s })).toBe(false);
    }
    expect(isSellerVerified({ ...base, verificationRevokedAt: new Date() })).toBe(false);
  });
});

describe('refreshSellerVerification', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    role: 'AUCTIONEER',
    verifiedAt: null,
    verificationRevokedAt: null,
    payoutAccount: { status: 'ACTIVE' },
    ...over,
  });
  beforeEach(() => vi.resetAllMocks());

  it('sets verifiedAt when the rule becomes true', async () => {
    db.member.findUnique.mockResolvedValue(row());
    const now = new Date('2026-11-15');
    expect(await refreshSellerVerification('s1', now)).toBe(true);
    expect(db.member.update).toHaveBeenCalledWith({ where: { id: 's1' }, data: { verifiedAt: now } });
  });

  it('keeps the original timestamp while still verified (no write)', async () => {
    db.member.findUnique.mockResolvedValue(row({ verifiedAt: new Date('2026-10-01') }));
    expect(await refreshSellerVerification('s1')).toBe(true);
    expect(db.member.update).not.toHaveBeenCalled();
  });

  it('clears verifiedAt when the payout account is no longer ACTIVE, it was revoked, or the role is not AUCTIONEER', async () => {
    for (const over of [
      { payoutAccount: { status: 'SUSPENDED' } },
      { payoutAccount: null },
      { verificationRevokedAt: new Date() },
      { role: 'BIDDER' },
    ]) {
      db.member.update.mockClear();
      db.member.findUnique.mockResolvedValue(row({ verifiedAt: new Date('2026-10-01'), ...over }));
      expect(await refreshSellerVerification('s1')).toBe(false);
      expect(db.member.update).toHaveBeenCalledWith({ where: { id: 's1' }, data: { verifiedAt: null } });
    }
  });

  it('unknown member -> false, no write', async () => {
    db.member.findUnique.mockResolvedValue(null);
    expect(await refreshSellerVerification('nope')).toBe(false);
    expect(db.member.update).not.toHaveBeenCalled();
  });
});

describe('admin verified toggle', () => {
  const adminRow = (over: Record<string, unknown> = {}) => ({
    id: 's1',
    name: 'S',
    email: 's@x.test',
    phone: '9876543210',
    role: 'AUCTIONEER',
    isActive: true,
    emailVerifiedAt: new Date(),
    verifiedAt: null,
    payoutAccount: { status: 'ACTIVE' },
    unpaidCommissionPaise: 0n,
    auctionsWon: 0,
    moneySpentPaise: 0n,
    createdAt: new Date(),
    ...over,
  });
  beforeEach(() => {
    vi.resetAllMocks();
    db.member.update.mockResolvedValue(adminRow());
  });

  it('verified=false revokes: sets verificationRevokedAt and clears verifiedAt', async () => {
    db.member.findUnique.mockResolvedValue({ id: 's1' });
    const dto = await updateMember('s1', 'admin1', { verified: false });
    expect(db.member.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { verificationRevokedAt: expect.any(Date), verifiedAt: null } }),
    );
    expect(dto).toMatchObject({ verified: false, payoutStatus: 'ACTIVE' });
    expect(dto).not.toHaveProperty('twoFactorEnabled');
    expect(dto).not.toHaveProperty('phoneVerifiedAt');
  });

  it('verified=true clears the revoke, then re-evaluates the rule', async () => {
    db.member.findUnique
      .mockResolvedValueOnce({ id: 's1' }) // existence check
      .mockResolvedValueOnce({ role: 'AUCTIONEER', verifiedAt: null, verificationRevokedAt: null, payoutAccount: { status: 'ACTIVE' } })
      .mockResolvedValueOnce(adminRow({ verifiedAt: new Date() }));
    const dto = await updateMember('s1', 'admin1', { verified: true });
    expect(db.member.update.mock.calls[0][0].data).toEqual({ verificationRevokedAt: null });
    expect(db.member.update.mock.calls[1][0]).toEqual({ where: { id: 's1' }, data: { verifiedAt: expect.any(Date) } });
    expect(dto.verified).toBe(true);
  });
});

describe('profile edit', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    db.member.update.mockResolvedValue({ id: 'm1', unpaidCommissionPaise: 0n, moneySpentPaise: 0n, verifiedAt: null });
  });

  it('phone is a plain contact field: changing it writes only the phone and never touches verification', async () => {
    await updateProfile('m1', { phone: '9123456789' });
    expect(db.member.findUnique).not.toHaveBeenCalled();
    expect(db.member.update).toHaveBeenCalledTimes(1);
    expect(db.member.update.mock.calls[0][0].data).toEqual({ phone: '9123456789' });
  });

  it('clearing the phone stores null', async () => {
    await updateProfile('m1', { phone: '' });
    expect(db.member.update.mock.calls[0][0].data).toEqual({ phone: null });
  });
});

describe('verified browse filter + seller badge', () => {
  const now = new Date('2026-11-15T10:00:00Z');
  it('verified=true adds seller.verifiedAt not null; absent / false does not', () => {
    const q = { status: 'live' as const, page: 1, pageSize: 20 };
    expect(JSON.stringify(listWhere({ ...q, verified: true }, now))).toContain('"seller":{"verifiedAt":{"not":null}}');
    expect(JSON.stringify(listWhere(q, now))).not.toContain('verifiedAt');
    expect(JSON.stringify(listWhere({ ...q, verified: false }, now))).not.toContain('verifiedAt');
  });

  it('cards carry seller.verified', () => {
    const row = (verifiedAt: Date | null) =>
      ({
        id: 'a1',
        title: 'T',
        category: 'c',
        condition: 'NEW',
        images: [],
        startingBidPaise: 100n,
        currentBidPaise: 0n,
        bidCount: 0,
        buyNowPricePaise: null,
        reservePricePaise: null,
        startTime: new Date('2026-11-01'),
        endTime: new Date('2026-11-20'),
        status: 'ACTIVE',
        deletedAt: null,
        seller: { id: 's1', name: 'S', avatarUrl: null, ratingCount: 0, ratingSum: 0, verifiedAt },
      }) as never;
    expect(toCard(row(new Date()), now).seller.verified).toBe(true);
    expect(toCard(row(null), now).seller.verified).toBe(false);
  });
});
