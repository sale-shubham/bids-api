import { toPaise } from '@/core/money';

// Shared Prisma `select`s for Member. NEVER return a Member row without one of
// these (or an explicit pick) — passwordHash must not leave the server.

export const memberProfileSelect = {
  id: true,
  email: true,
  name: true,
  phone: true,
  avatarUrl: true,
  address: true,
  role: true,
  isActive: true,
  emailVerifiedAt: true,
  phoneVerifiedAt: true,
  twoFactorEnabledAt: true,
  verifiedAt: true,
  unpaidCommissionPaise: true,
  auctionsWon: true,
  moneySpentPaise: true,
  createdAt: true,
} as const;

// Visible to anyone (GET /members/:id/public).
export const memberPublicSelect = {
  id: true,
  name: true,
  avatarUrl: true,
  role: true,
  ratingCount: true,
  ratingSum: true,
  verifiedAt: true,
  createdAt: true,
} as const;

type MemberTrust = { twoFactorEnabledAt: Date | null; verifiedAt: Date | null };

/** Turns the internal 2FA / verification timestamps into the client booleans (never expose twoFactorEnabledAt). */
export function withMemberTrust<T extends MemberTrust>(m: T): Omit<T, keyof MemberTrust> & { twoFactorEnabled: boolean; verified: boolean } {
  const { twoFactorEnabledAt, verifiedAt, ...rest } = m;
  return { ...rest, twoFactorEnabled: !!twoFactorEnabledAt, verified: !!verifiedAt };
}

type MemberMoney = { unpaidCommissionPaise: bigint | number; moneySpentPaise: bigint | number };

/** Convert a member row's BigInt money columns to plain numbers (JSON contract). */
export function withMemberMoney<T extends MemberMoney>(m: T): Omit<T, keyof MemberMoney> & { unpaidCommissionPaise: number; moneySpentPaise: number } {
  return { ...m, unpaidCommissionPaise: toPaise(m.unpaidCommissionPaise), moneySpentPaise: toPaise(m.moneySpentPaise) };
}
