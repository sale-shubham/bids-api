import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => {
  const d: any = {
    member: { findUnique: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
    referral: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
    session: { findMany: vi.fn(), findFirst: vi.fn() },
    memberCredit: { aggregate: vi.fn(), create: vi.fn(), count: vi.fn(), findMany: vi.fn(), groupBy: vi.fn() },
    appSetting: { findUnique: vi.fn() },
    commission: { findUnique: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
    invoice: { findUnique: vi.fn() },
    $queryRaw: vi.fn(async () => []),
    $executeRaw: vi.fn(async () => 1),
  };
  d.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(d));
  return d;
});
const enqueue = vi.hoisted(() => vi.fn(async (_m: unknown) => undefined));
vi.mock('@/core/prisma/client', () => ({ prisma: db }));
vi.mock('@/core/logger/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/notify/notify.queue', () => ({ enqueueNotification: enqueue }));

import { Prisma } from '@prisma/client';
import { REFERRAL_CODE_RE, decideReward, generateReferralCode, parseReferralConfig } from './referrals.rules';
import * as svc from './referrals.service';
import { adminAdjust, debitCredits, listLedger } from '@/modules/credits/credits.service';
import { payWithCredits } from '@/modules/commissions/commissions.service';

const now = new Date('2026-11-16T10:00:00Z');
const uniqueErr = () => new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' });
const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => `${e.statusCode}:${e.code}`,
  );
const setting = (map: Record<string, string>) =>
  db.appSetting.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => (where.key in map ? { key: where.key, value: map[where.key] } : null));

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  setting({});
  db.session.findMany.mockResolvedValue([{ deviceId: 'dev-a' }]);
  db.session.findFirst.mockResolvedValue(null);
  db.referral.count.mockResolvedValue(0);
  db.referral.updateMany.mockResolvedValue({ count: 1 });
  db.memberCredit.aggregate.mockResolvedValue({ _sum: { amountPaise: 50_000n } });
  db.memberCredit.create.mockResolvedValue({ id: 'cr1' });
});

describe('referral codes', () => {
  it('generates 8-char uppercase base32 codes', () => {
    for (let i = 0; i < 50; i++) expect(generateReferralCode()).toMatch(REFERRAL_CODE_RE);
    expect(generateReferralCode(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]))).toBe('ABCDEFGH');
  });
  it('lazily generates and stores a code; returns the existing one untouched', async () => {
    db.member.findUnique.mockResolvedValueOnce({ referralCode: null }).mockResolvedValueOnce({ referralCode: 'ABCD2345' });
    expect(await svc.getOrCreateCode('m1')).toBe('ABCD2345');
    expect(db.member.updateMany.mock.calls[0][0].where).toEqual({ id: 'm1', referralCode: null });
    db.member.updateMany.mockClear();
    db.member.findUnique.mockReset().mockResolvedValue({ referralCode: 'KEEPKEEP' });
    expect(await svc.getOrCreateCode('m1')).toBe('KEEPKEEP');
    expect(db.member.updateMany).not.toHaveBeenCalled();
  });
  it('retries on a unique collision', async () => {
    db.member.findUnique.mockResolvedValueOnce({ referralCode: null }).mockResolvedValueOnce({ referralCode: 'ZZZZ2222' });
    db.member.updateMany.mockRejectedValueOnce(uniqueErr()).mockResolvedValueOnce({ count: 1 });
    expect(await svc.getOrCreateCode('m1')).toBe('ZZZZ2222');
    expect(db.member.updateMany).toHaveBeenCalledTimes(2);
  });
});

describe('signup attach', () => {
  it('valid code creates a PENDING referral (case-insensitive)', async () => {
    db.member.findUnique.mockResolvedValue({ id: 'ref1' });
    expect(await svc.attachReferral('new1', ' abcd2345 ')).toBe(true);
    expect(db.member.findUnique.mock.calls[0][0].where).toEqual({ referralCode: 'ABCD2345' });
    expect(db.referral.create).toHaveBeenCalledWith({ data: { referrerId: 'ref1', refereeId: 'new1' } });
  });
  it('own code, unknown code, malformed code and disabled program are ignored silently', async () => {
    db.member.findUnique.mockResolvedValue({ id: 'new1' });
    expect(await svc.attachReferral('new1', 'ABCD2345')).toBe(false);
    db.member.findUnique.mockResolvedValue(null);
    expect(await svc.attachReferral('new1', 'ABCD2345')).toBe(false);
    expect(await svc.attachReferral('new1', 'bad')).toBe(false);
    expect(await svc.attachReferral('new1', undefined)).toBe(false);
    setting({ 'referral.enabled': 'false' });
    db.member.findUnique.mockResolvedValue({ id: 'ref1' });
    expect(await svc.attachReferral('new1', 'ABCD2345')).toBe(false);
    expect(db.referral.create).not.toHaveBeenCalled();
  });
  it('an already-referred account is not attached twice', async () => {
    db.member.findUnique.mockResolvedValue({ id: 'ref1' });
    db.referral.create.mockRejectedValue(uniqueErr());
    expect(await svc.attachReferral('new1', 'ABCD2345')).toBe(false);
  });
});

describe('qualification and reward', () => {
  beforeEach(() => db.referral.findUnique.mockResolvedValue({ id: 'r1', referrerId: 'ref1', status: 'PENDING' }));

  it('rewards the referrer: QUALIFIED -> REWARDED, ledger row REFERRAL_REWARD, notification', async () => {
    expect(await svc.qualifyReferral('new1', now)).toEqual({ status: 'REWARDED' });
    expect(db.referral.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'r1', status: 'PENDING' }, data: { status: 'QUALIFIED' } });
    expect(db.memberCredit.create.mock.calls[0][0].data).toMatchObject({ memberId: 'ref1', amountPaise: 10_000n, reason: 'REFERRAL_REWARD', refType: 'REFERRAL', refId: 'r1' });
    expect(enqueue.mock.calls[0][0]).toMatchObject({ type: 'referral-rewarded', memberId: 'ref1', dedupeKey: 'referral-rewarded:r1' });
  });
  it('shared device -> REJECTED SAME_DEVICE, no credit', async () => {
    db.session.findFirst.mockResolvedValue({ id: 's1' });
    expect(await svc.qualifyReferral('new1', now)).toEqual({ status: 'REJECTED' });
    expect(db.referral.updateMany.mock.calls[1][0].data).toEqual({ status: 'REJECTED', rejectReason: 'SAME_DEVICE' });
    expect(db.memberCredit.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('cap reached -> REJECTED CAP_REACHED', async () => {
    db.referral.count.mockResolvedValue(20);
    expect(await svc.qualifyReferral('new1', now)).toEqual({ status: 'REJECTED' });
    expect(db.referral.updateMany.mock.calls[1][0].data).toEqual({ status: 'REJECTED', rejectReason: 'CAP_REACHED' });
  });
  it('is idempotent: no referral, not pending, or lost race do nothing', async () => {
    db.referral.findUnique.mockResolvedValue(null);
    expect(await svc.qualifyReferral('x', now)).toEqual({ status: 'NONE' });
    db.referral.findUnique.mockResolvedValue({ id: 'r1', referrerId: 'ref1', status: 'REWARDED' });
    expect(await svc.qualifyReferral('x', now)).toEqual({ status: 'NONE' });
    db.referral.findUnique.mockResolvedValue({ id: 'r1', referrerId: 'ref1', status: 'PENDING' });
    db.referral.updateMany.mockResolvedValue({ count: 0 });
    expect(await svc.qualifyReferral('x', now)).toEqual({ status: 'NONE' });
    expect(db.memberCredit.create).not.toHaveBeenCalled();
  });
  it('program disabled leaves the referral QUALIFIED without a reward', async () => {
    setting({ 'referral.enabled': 'false' });
    expect(await svc.qualifyReferral('new1', now)).toEqual({ status: 'QUALIFIED' });
    expect(db.memberCredit.create).not.toHaveBeenCalled();
  });
  it('decideReward and config parsing', () => {
    expect(decideReward({ sharedDevice: true, rewardedCount: 99, max: 1 })).toEqual({ outcome: 'REJECT', reason: 'SAME_DEVICE' });
    expect(decideReward({ sharedDevice: false, rewardedCount: 19, max: 20 })).toEqual({ outcome: 'REWARD' });
    expect(parseReferralConfig(null, null, null)).toEqual({ enabled: true, rewardPaise: 10_000, maxRewardsPerMember: 20 });
    expect(parseReferralConfig('false', '5000', '3')).toEqual({ enabled: false, rewardPaise: 5000, maxRewardsPerMember: 3 });
  });
  it('the paid-commission path triggers qualification for the seller', async () => {
    db.commission.findFirst.mockResolvedValue({ id: 'c1', sellerId: 'new1', auctionId: 'a1', amountPaise: 5_000n, status: 'DUE' });
    db.commission.updateMany.mockResolvedValue({ count: 1 });
    db.memberCredit.aggregate.mockResolvedValue({ _sum: { amountPaise: 5_000n } });
    await code(payWithCredits('new1', 'c1', now));
    expect(db.referral.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { refereeId: 'new1' } }));
  });
});

describe('credits ledger', () => {
  it('a debit takes the member row lock first and never goes below zero', async () => {
    db.memberCredit.aggregate.mockResolvedValue({ _sum: { amountPaise: 999n } });
    expect(await code(debitCredits(db, { memberId: 'm1', amountPaise: 1000, reason: 'FEATURE_PURCHASE' }))).toBe('409:INSUFFICIENT_CREDITS');
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(db.memberCredit.create).not.toHaveBeenCalled();
    db.memberCredit.aggregate.mockResolvedValue({ _sum: { amountPaise: 1000n } });
    await debitCredits(db, { memberId: 'm1', amountPaise: 1000, reason: 'FEATURE_PURCHASE' });
    expect(db.memberCredit.create.mock.calls[0][0].data.amountPaise).toBe(-1000n);
  });

  it('commission paid with credits: debit + DUE -> PAID + unpaid decrement in one transaction', async () => {
    db.commission.findFirst.mockResolvedValue({ id: 'c1', sellerId: 's1', auctionId: 'a1', amountPaise: 5_000n, status: 'DUE' });
    db.commission.updateMany.mockResolvedValue({ count: 1 });
    db.commission.findUnique.mockResolvedValue(null);
    await code(payWithCredits('s1', 'c1', now));
    expect(db.memberCredit.create.mock.calls[0][0].data).toMatchObject({ amountPaise: -5_000n, reason: 'COMMISSION_PAYMENT' });
    expect(db.commission.updateMany).toHaveBeenCalledWith({ where: { id: 'c1', status: 'DUE' }, data: { status: 'PAID', paidAt: now } });
    expect(db.$executeRaw).toHaveBeenCalled();
    expect(enqueue.mock.calls[0][0]).toMatchObject({ type: 'commission-paid' });
  });
  it('commission credits: insufficient -> 409, commission untouched; not DUE -> 409', async () => {
    db.commission.findFirst.mockResolvedValue({ id: 'c1', sellerId: 's1', auctionId: 'a1', amountPaise: 60_000n, status: 'DUE' });
    expect(await code(payWithCredits('s1', 'c1', now))).toBe('409:INSUFFICIENT_CREDITS');
    expect(db.commission.updateMany).not.toHaveBeenCalled();
    db.commission.findFirst.mockResolvedValue({ id: 'c1', sellerId: 's1', auctionId: 'a1', amountPaise: 100n, status: 'PAID' });
    expect(await code(payWithCredits('s1', 'c1', now))).toBe('409:COMMISSION_NOT_DUE');
  });

  it('admin adjustment: credit adds, debit cannot go below 0', async () => {
    db.member.findUnique.mockResolvedValue({ id: 'm1' });
    db.memberCredit.aggregate.mockResolvedValue({ _sum: { amountPaise: 2_000n } });
    await adminAdjust('m1', 'admin1', { amountPaise: 500, note: 'goodwill' });
    expect(db.memberCredit.create.mock.calls[0][0].data).toMatchObject({ amountPaise: 500n, reason: 'ADMIN_ADJUSTMENT', createdById: 'admin1', note: 'goodwill' });
    db.memberCredit.create.mockClear();
    expect(await code(adminAdjust('m1', 'admin1', { amountPaise: -5_000, note: 'too much' }))).toBe('409:INSUFFICIENT_CREDITS');
    expect(db.memberCredit.create).not.toHaveBeenCalled();
    await adminAdjust('m1', 'admin1', { amountPaise: -2_000, note: 'clawback' });
    expect(db.memberCredit.create.mock.calls[0][0].data.amountPaise).toBe(-2_000n);
    db.member.findUnique.mockResolvedValue(null);
    expect(await code(adminAdjust('zz', 'admin1', { amountPaise: 1, note: 'nope' }))).toBe('404:NOT_FOUND');
  });

  it('ledger listing returns rows and the balance', async () => {
    db.memberCredit.findMany.mockResolvedValue([{ id: 'x', amountPaise: 100n, reason: 'REFERRAL_REWARD', note: null, createdAt: now }]);
    db.memberCredit.count.mockResolvedValue(1);
    const r = await listLedger('m1', { page: 1, pageSize: 20 });
    expect(r.items).toEqual([{ id: 'x', amountPaise: 100, reason: 'REFERRAL_REWARD', note: null, createdAt: now }]);
    expect(r.balancePaise).toBe(50_000);
  });

  it('referral summary: code, link, counts, balance', async () => {
    db.member.findUnique.mockResolvedValue({ referralCode: 'ABCD2345' });
    db.referral.groupBy.mockResolvedValue([{ status: 'PENDING', _count: { _all: 2 } }, { status: 'REWARDED', _count: { _all: 1 } }]);
    const s = await svc.getReferralSummary('m1');
    expect(s).toMatchObject({ code: 'ABCD2345', rewardPaise: 10_000, enabled: true, counts: { pending: 2, qualified: 0, rewarded: 1, rejected: 0 }, creditBalancePaise: 50_000 });
    expect(s.link).toMatch(/\/signup\?ref=ABCD2345$/);
  });
});
