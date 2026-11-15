import { Prisma } from '@prisma/client';
import { prisma } from '@/core/prisma/client';
import { env } from '@/core/config/env';
import { bestEffort } from '@/core/best-effort';
import { getSetting } from '@/modules/settings/settings.service';
import { enqueueNotification } from '@/modules/notify/notify.queue';
import { creditBalance, grantCredits, lockMember } from '@/modules/credits/credits.service';
import {
  REFERRAL_CODE_RE,
  REFERRAL_ENABLED_KEY,
  REFERRAL_MAX_KEY,
  REFERRAL_REWARD_KEY,
  decideReward,
  generateReferralCode,
  parseReferralConfig,
  type ReferralConfig,
} from './referrals.rules';

const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

export async function getReferralConfig(): Promise<ReferralConfig> {
  const [enabled, reward, max] = await Promise.all([getSetting(REFERRAL_ENABLED_KEY), getSetting(REFERRAL_REWARD_KEY), getSetting(REFERRAL_MAX_KEY)]);
  return parseReferralConfig(enabled, reward, max);
}

/** The member's referral code, generated lazily (retries on the rare unique collision). */
export async function getOrCreateCode(memberId: string): Promise<string> {
  const m = await prisma.member.findUnique({ where: { id: memberId }, select: { referralCode: true } });
  if (m?.referralCode) return m.referralCode;
  for (let i = 0; i < 5; i++) {
    try {
      await prisma.member.updateMany({ where: { id: memberId, referralCode: null }, data: { referralCode: generateReferralCode() } });
      break;
    } catch (err) {
      if (!isUnique(err)) throw err;
    }
  }
  const again = await prisma.member.findUnique({ where: { id: memberId }, select: { referralCode: true } });
  if (!again?.referralCode) throw new Error('could not generate a referral code');
  return again.referralCode;
}

/** Signup: a valid code (not the member's own, referral enabled) creates a PENDING referral. Invalid codes are ignored silently. */
export async function attachReferral(refereeId: string, rawCode: string | undefined | null): Promise<boolean> {
  const code = (rawCode ?? '').trim().toUpperCase();
  if (!REFERRAL_CODE_RE.test(code)) return false;
  if (!(await getReferralConfig()).enabled) return false;
  const referrer = await prisma.member.findUnique({ where: { referralCode: code }, select: { id: true } });
  if (!referrer || referrer.id === refereeId) return false;
  try {
    await prisma.referral.create({ data: { referrerId: referrer.id, refereeId } });
    return true;
  } catch (err) {
    if (isUnique(err)) return false; // already referred
    throw err;
  }
}

/**
 * The referee completed a first paid transaction: PENDING -> QUALIFIED, then reward (or reject) the referrer.
 * Idempotent: only the call that wins the guarded PENDING -> QUALIFIED update proceeds.
 */
export async function qualifyReferral(refereeId: string, now = new Date()): Promise<{ status: 'NONE' | 'REWARDED' | 'REJECTED' | 'QUALIFIED' }> {
  const referral = await prisma.referral.findUnique({ where: { refereeId }, select: { id: true, referrerId: true, status: true } });
  if (!referral || referral.status !== 'PENDING') return { status: 'NONE' };
  const moved = await prisma.referral.updateMany({ where: { id: referral.id, status: 'PENDING' }, data: { status: 'QUALIFIED', qualifiedAt: now } });
  if (moved.count !== 1) return { status: 'NONE' };

  const cfg = await getReferralConfig();
  if (!cfg.enabled) return { status: 'QUALIFIED' };

  const referrerDevices = await prisma.session.findMany({ where: { memberId: referral.referrerId }, select: { deviceId: true } });
  const deviceIds = referrerDevices.map((d) => d.deviceId);
  const shared = deviceIds.length ? await prisma.session.findFirst({ where: { memberId: refereeId, deviceId: { in: deviceIds } }, select: { id: true } }) : null;
  const rewardedCount = await prisma.referral.count({ where: { referrerId: referral.referrerId, status: 'REWARDED' } });
  const decision = decideReward({ sharedDevice: !!shared, rewardedCount, max: cfg.maxRewardsPerMember });

  if (decision.outcome === 'REJECT') {
    await prisma.referral.updateMany({ where: { id: referral.id, status: 'QUALIFIED' }, data: { status: 'REJECTED', rejectReason: decision.reason } });
    return { status: 'REJECTED' };
  }

  const rewarded = await prisma.$transaction(async (tx) => {
    await lockMember(tx, referral.referrerId);
    const { count } = await tx.referral.updateMany({ where: { id: referral.id, status: 'QUALIFIED' }, data: { status: 'REWARDED', rewardedAt: now } });
    if (count !== 1) return false;
    await grantCredits(tx, { memberId: referral.referrerId, amountPaise: cfg.rewardPaise, reason: 'REFERRAL_REWARD', refType: 'REFERRAL', refId: referral.id });
    return true;
  });
  if (!rewarded) return { status: 'QUALIFIED' };
  await enqueueNotification({
    type: 'referral-rewarded',
    memberId: referral.referrerId,
    data: { rewardPaise: cfg.rewardPaise },
    dedupeKey: `referral-rewarded:${referral.id}`,
  });
  return { status: 'REWARDED' };
}

/** Best-effort hook for the paid-transaction paths (release, commission paid). */
export const qualifyReferralBestEffort = (memberIds: string[], now = new Date()) =>
  bestEffort('referral: qualify', async () => {
    for (const id of new Set(memberIds)) await qualifyReferral(id, now);
  }, { memberIds });

export async function getReferralSummary(memberId: string) {
  const [code, cfg, groups, balance] = await Promise.all([
    getOrCreateCode(memberId),
    getReferralConfig(),
    prisma.referral.groupBy({ by: ['status'], where: { referrerId: memberId }, _count: { _all: true } }),
    creditBalance(prisma, memberId),
  ]);
  const n = (s: string) => groups.find((g) => g.status === s)?._count._all ?? 0;
  return {
    code,
    link: `${env.app.url}/signup?ref=${code}`,
    rewardPaise: cfg.rewardPaise,
    enabled: cfg.enabled,
    counts: { pending: n('PENDING'), qualified: n('QUALIFIED'), rewarded: n('REWARDED'), rejected: n('REJECTED') },
    creditBalancePaise: balance,
  };
}
