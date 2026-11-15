import { prisma } from '@/core/prisma/client';

export type VerificationFacts = {
  role: string;
  payoutStatus: string | null | undefined;
  verificationRevokedAt: Date | null;
};

/** Pure rule: AUCTIONEER + ACTIVE payout account + not revoked by an admin. */
export function isSellerVerified(f: VerificationFacts): boolean {
  return f.role === 'AUCTIONEER' && f.payoutStatus === 'ACTIVE' && !f.verificationRevokedAt;
}

/** Recomputes Member.verifiedAt (keeps the original timestamp while still verified). Returns the new state. */
export async function refreshSellerVerification(memberId: string, now = new Date()): Promise<boolean> {
  const m = await prisma.member.findUnique({
    where: { id: memberId },
    select: {
      role: true,
      verifiedAt: true,
      verificationRevokedAt: true,
      payoutAccount: { select: { status: true } },
    },
  });
  if (!m) return false;
  const verified = isSellerVerified({ ...m, payoutStatus: m.payoutAccount?.status });
  if (verified && !m.verifiedAt) await prisma.member.update({ where: { id: memberId }, data: { verifiedAt: now } });
  else if (!verified && m.verifiedAt) await prisma.member.update({ where: { id: memberId }, data: { verifiedAt: null } });
  return verified;
}
