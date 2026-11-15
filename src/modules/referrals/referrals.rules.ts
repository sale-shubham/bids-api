import crypto from 'node:crypto';

export const REFERRAL_ENABLED_KEY = 'referral.enabled';
export const REFERRAL_REWARD_KEY = 'referral.rewardPaise';
export const REFERRAL_MAX_KEY = 'referral.maxRewardsPerMember';
export const DEFAULT_REFERRAL = { enabled: true, rewardPaise: 10_000, maxRewardsPerMember: 20 } as const;

// RFC 4648 base32 alphabet; codes are 8 chars (40 bits of randomness).
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const REFERRAL_CODE_RE = /^[A-Z2-7]{8}$/;

export function generateReferralCode(bytes: Buffer = crypto.randomBytes(8)): string {
  let out = '';
  for (let i = 0; i < 8; i++) out += B32[bytes[i] % 32];
  return out;
}

const intOr = (raw: string | null | undefined, fallback: number, min: number, max: number) => {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};

export type ReferralConfig = { enabled: boolean; rewardPaise: number; maxRewardsPerMember: number };

export function parseReferralConfig(enabled: string | null | undefined, reward: string | null | undefined, max: string | null | undefined): ReferralConfig {
  return {
    enabled: enabled !== 'false',
    rewardPaise: intOr(reward, DEFAULT_REFERRAL.rewardPaise, 100, 100_000_000),
    maxRewardsPerMember: intOr(max, DEFAULT_REFERRAL.maxRewardsPerMember, 0, 10_000),
  };
}

export type RewardDecision = { outcome: 'REWARD' } | { outcome: 'REJECT'; reason: 'SAME_DEVICE' | 'CAP_REACHED' };

/** Same device wins over the cap; otherwise reward until the referrer has `max` rewarded referrals. */
export function decideReward(input: { sharedDevice: boolean; rewardedCount: number; max: number }): RewardDecision {
  if (input.sharedDevice) return { outcome: 'REJECT', reason: 'SAME_DEVICE' };
  if (input.rewardedCount >= input.max) return { outcome: 'REJECT', reason: 'CAP_REACHED' };
  return { outcome: 'REWARD' };
}
