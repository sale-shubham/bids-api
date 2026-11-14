import { prisma } from '@/core/prisma/client';

export const profileSelect = {
  id: true,
  email: true,
  name: true,
  phone: true,
  avatarUrl: true,
  address: true,
  role: true,
  isActive: true,
  emailVerifiedAt: true,
  unpaidCommissionPaise: true,
  auctionsWon: true,
  moneySpentPaise: true,
  createdAt: true,
} as const;

export async function getProfile(memberId: string) {
  return prisma.member.findUnique({ where: { id: memberId }, select: profileSelect });
}

// Empty strings clear the optional fields.
export async function updateProfile(
  memberId: string,
  input: { name?: string; phone?: string | null; address?: string | null; avatarUrl?: string | null },
) {
  const data: Record<string, string | null> = {};
  if (input.name !== undefined) data.name = input.name;
  for (const k of ['phone', 'address', 'avatarUrl'] as const) {
    if (input[k] !== undefined) data[k] = input[k] || null;
  }
  return prisma.member.update({ where: { id: memberId }, data, select: profileSelect });
}
